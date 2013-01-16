var pg = require('pg');
var redis = require('redis');
var config = require(__dirname + '/' + process.argv[2]);
var os = require('os');
var spawn = require('child_process').spawn;
var fs = require('fs');

var connect_params = {
    user : config.dbuser,
    host : config.dbhost,
    database : config.dbname,
    port : config.dbport || 5432,
    password : config.dbpass
};

var channel = 'postgres-high-availability-' + config.dbhost;
var msg_src = os.hostname() + '::' + process.pid;
var subscriber = redis.createClient(config.redis_port || 6379, config.redis_host);
var publisher = redis.createClient(config.redis_port || 6379, config.redis_host);
var rclient = redis.createClient(config.redis_port || 6379, config.redis_host);

rclient.del(channel + '-race-for-leader');

var reconnect;
var failure = false;
var sdown_count = 0;
var loser = 0;
var sdowns = {};

subscriber.on('message', function(chan, msg) {
    msg = JSON.parse(msg);
    console.log(msg);
    if(msg.msg === '+SDOWN') {

        // only count the unique +SDOWN messages
        sdowns[msg.src] = msg;
        sdown_count = 0;
        for(var m in sdowns) ++sdown_count;

        console.log(msg.src + ' detected SDOWN state on dbhost ' + config.dbhost);
        console.log('SDOWN state ' + sdown_count + '/' + config.required_sdown);

        if(sdown_count >= config.required_sdown) {
            setTimeout(function() {
                console.log('publishing ODOWN');
                sdown_count = 0;
                for(var m in sdowns) ++sdown_count;
                if(sdown_count >= config.required_sdown)
                    publisher.publish(channel, JSON.stringify({ msg : '+ODOWN', src : msg_src, ts : (new Date()).getTime() }));
            }, 2000);
        }
    }
    if(msg.msg === '-SDOWN') {
        if(sdowns[msg.src]) {
            delete sdowns[msg.src];
            console.log(msg.src,'detected dbhost',config.dbhost,'returned to service');
        }
    }
    if(msg.msg === '+ODOWN') {
        console.log(msg_src + ' detected ODOWN state on dbhost ' + config.dbhost);
        if(!config.monitoring_master) {
            // notify slave is down
            console.log('slave ', config.dbhost,'is down');
            return;
        }
        setTimeout(function() {
            sdown_count = 0;
            for(var m in sdowns) ++sdown_count;                        
            if(sdown_count >= config.required_sdown) {
                console.log(config.dbhost,'has been down for more than 10 seconds. Failing over...');
                rclient.setnx(channel + '-race-for-leader', msg_src, function(err,rep) {

                    // won the race so we have to perform the failover
                    var trigger_slave_retries = 0;
                    var trigger_slave = function() {                
                        var trigger = spawn('ssh', [
                            '-o', 'UserKnownHostsFile=/dev/null',
                            '-o', 'StrictHostKeyChecking=no',
                            config.dbslave,
                            'touch', config.db_failover_trigger_file
                        ]);
                        trigger.stdout.pipe(process.stdout);
                        trigger.stderr.pipe(process.stderr);
                        trigger.on('exit', function(code, signal) {
                            if(code != 0) {
                                console.log('failed to trigger failover to slave on ' + config.dbslave);
                                ++trigger_slave_retries;
                                if(trigger_slave_retries < 5)
                                    trigger_slave();
                                // maybe try more if we have them
                            } else {
                                console.log('triggered slave to failover');
                                
                                var stop_master = spawn('ssh', [
                                    '-tt',
                                    '-o', 'UserKnownHostsFile=/dev/null',
                                    '-o', 'StrictHostKeyChecking=no',
                                    config.dbhost,
                                    'sudo /etc/init.d/postgresql-9.2 stop'
                                ]);
                                stop_master.stdout.pipe(process.stdout);
                                stop_master.stderr.pipe(process.stderr);
                                stop_master.on('exit', function(code,signal) {
                                    
                                    // update hosts files
                                    var num_hosts = config.host_list.length;
                                    var updated = 0;
                                    var hosts_retries = {};
                                    var update_hosts_file = function(host) {  
                                        console.log('updating ' + host);
                                        var hosts = spawn('ssh', [
                                            '-tt',
                                            '-o', 'UserKnownHostsFile=/dev/null',
                                            '-o', 'StrictHostKeyChecking=no',
                                            host,
                                            'sudo /home/sofi/hosts.sh',
                                            config.dbslave,
                                            config.dbhostname
                                        ]);
                                        hosts.stdout.pipe(process.stdout);
                                        hosts.stderr.pipe(process.stderr);
                                        hosts.on('exit', function(code, signal) {
                                            if(code != 0) {
                                                console.log('failed to update hosts file on ' + host);
                                                hosts_retries[host] += 1;
                                                if(hosts_retries[host] < 5)
                                                    update_hosts_file(host);
                                            } else {
                                                console.log('successfully updated hosts file on ' + host);
                                                ++updated;
                                            }
                                            if(updated == num_hosts) {
                                                console.log('failover complete');
                                                fs.writeFile(config.snmp_trigger_file, 'failover', function(err) {
                                                    if(err) {
                                                        console.log('failed to create file configured to trigger snmp notification')
                                                    }
                                                    publisher.publish(channel, JSON.stringify({ msg : 'failover-complete', src : msg_src, ts : (new Date()).getTime() }), function(err,rep) {
                                                        process.exit(0);
                                                    });
                                                });
                                            }
                                        });
                                    };
                                    for(var i=0;i<config.host_list.length;++i) {
                                        hosts_retries[config.host_list[i]] = 0;
                                        update_hosts_file(config.host_list[i]);
                                    }
                                });
                            }
                        });
                    };

                    if(rep == 1) {
                        console.log('executing failover and updating hosts files');
                        trigger_slave();
                    } else {                
                        console.log('another instance is handling failover');
                        // in case the sentinel that won the race fails to perform the failover
                        // this sentinel will try in 15 seconds. This code won't execute if the
                        // failover-complete message is received during this interval as we will exit
                        setTimeout(function() {
                            trigger_slave();
                        }, 15000);
                    }            
                });
            }
        },30000);
    }
    if(msg.msg == 'failover-complete') {
        process.exit(0);
    }
});

var times_connect_failed = 0;

subscriber.subscribe(channel);
console.log('subscribed to ' + channel);

function failover() {
    connect_params.host = 'yyc-sofi_db_m';
    setTimeout(reconnect, 5000);
}

pg.on('error', function(err) {
    console.log('pg error ' + err);
    publisher.publish(channel, JSON.stringify({ msg : '+SDOWN', src : msg_src, ts : (new Date()).getTime() }));
    ++times_connect_failed;
    if(times_connect_failed < 3)
        failover();
    else {
        setTimeout(function() {
            process.exit(-1);
        }, 15000);
    }
});

var connection;
var heartbeat = 0;
var last_heartbeat = -1;
var times_unchanged = 0;

reconnect = function() {
    failure = false;
    console.log('connecting to',require('util').inspect(connect_params));
    connection = new pg.Client(connect_params);
    connection.on('error', function(err) {
        console.log('pg.Client error ' + err);
        publisher.publish(channel, JSON.stringify({ msg : '+SDOWN', src : msg_src, ts : (new Date()).getTime() }));
        ++times_connect_failed;
        if(times_connect_failed < 3)
            failover();
        else {
            setTimeout(function() {
                process.exit(-1);
            }, 15000);
        }
    });
    connection.connect(function(err) {
        if(err) { 
            ++times_connect_failed;
            console.log('connection error:', err); 
            failure = true;
            if(times_connect_failed < 3)
                failover();
        }
        var write_query = "UPDATE heartbeat SET ok = $1";
        var read_query = "SELECT * FROM heartbeat";
        
        var health_check = function() {
            rclient.setex(channel + '-' + os.hostname(), (config.interval * 2) / 1000, 'alive', function() {
            });
            if(config.monitoring_master) {
                try {
                    var r = connection.query(write_query, [(new Date()).getTime()], function(err, res) {
                        if(err) {
                            console.log('there was an error with query', write_query, err);
                            publisher.publish(channel, JSON.stringify({ msg : '+SDOWN', src : msg_src, ts : (new Date()).getTime() }));
                            failure = true;
                        } else {
                            failure = false;
                            if(sdowns[msg_src])
                                publisher.publish(channel, JSON.stringify({ msg : '-SDOWN', src : msg_src, ts : (new Date()).getTime() }));
                        }
                    });
                } catch(err) {
                    console.log('there was an error ' + err);
                    publisher.publish(channel, JSON.stringify({ msg : '+SDOWN', src : msg_src, ts : (new Date()).getTime() }));
                    failure = true;
                }
            }
            try {
                var r = connection.query(read_query, function(err, res) {
                    if(err) {
                        console.log('there was an error with query', read_query, err);
                        publisher.publish(channel, JSON.stringify({ msg : '+SDOWN', src : msg_src, ts : (new Date()).getTime() }));
                        failure = true;
                    } else {
                        if(res.rows.length != 1) {
                            console.log('failed to read from db');
                            publisher.publish(channel, JSON.stringify({ msg : '+SDOWN', src : msg_src, ts : (new Date()).getTime() }));
                            failure = true;
                        } else {
                            heartbeat = res.rows[0].ok;
                            failure = false;
                            if(sdowns[msg_src])
                                publisher.publish(channel, JSON.stringify({ msg : '-SDOWN', src : msg_src, ts : (new Date()).getTime() }));
                        }
                    }
                });
            } catch(err) {
                console.log('there was an error ' + err);
                publisher.publish(channel, JSON.stringify({ msg : '+SDOWN', src : msg_src, ts : (new Date()).getTime() }));
                failure = true;
            }
            if(last_heartbeat != heartbeat) {
                last_heartbeat = heartbeat;
                times_unchanged = 0;
            }
            else ++times_unchanged;
            if(times_unchanged >= 6) {
                failure = true;
                console.log("query failed to execute after " + config.interval * 6 + " milliseconds");
                publisher.publish(channel, JSON.stringify({ msg : '+SDOWN', src : msg_src, ts : (new Date()).getTime() }));
            }
            if(!failure) setTimeout(health_check, config.interval);
        };
        health_check();
    });
};

reconnect();