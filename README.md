PG_SENTINEL
===========

This is a relatively simple node.js script that monitors a high-availability postgres setup, 
performs automated failover. The postgres documentation used to set up replication and failover is (http://wiki.postgresql.org/wiki/Streaming_Replication).
The technique used to identify a failure situation is similar to the way redis-sentinel works (http://redis.io/topics/sentinel).

The sentinel expects a table called 'heartbeat' to exist with a column for a large integer called 'ok'.
The sentinel then sends both write and read queries to the host it is monitoring, updating and reading from 'heartbeat'.

If an error occurs or a query fails the sentinel publishes to a redis channel that the postgres instance is subjectively down.
The sentinel is subscribed to this channel and if the configured level of agreement is reached based on multiple instances of the sentinel
monitoring the postgres instance, then the sentinel publishes to the redis channel that the postgres instance is objectively down.
Once the message is received that the postgres instance is objectively down the sentinels race to see who will perform the failover using 
the redis SETNX command. The sentinel that wins the race then executes commands over ssh to create the trigger file on the postgres slave,
and update /etc/hosts on the list of hosts.

USAGE
=====

To run:

        node lib config

The config parameter should be a .js file that exports an object:

```js
        var config = {  
            dbname: 'the-database-name-to-connect-to'
            , dbuser: 'the-username-to-connect-with'
            , dbpass: 'your-password-to-access-postgres'
            , dbhost: 'the-postgres-master-instance'
            , dbport: 5432 // the postgres port to connect on
            , dbslave: 'the-postgres-slave-to-failover-to'
            , redis_host: 'the-redis-host'
            , redis_port: 6379 // redis port to connect to
            , monitoring_master: true // false if you are using this sentinel to monitor the slave and send notification
            , interval: 1000 // frequency in milliseconds to ping the postgres instance
            , dbhostname: 'hostname-clients-use-to-connect-to-postgres'
            , db_failover_trigger_file: '/path/to/trigger.file'
            , required_sdown: 2  // how many sentinels need to say the postgres instance is down before attempting failover
            , host_list: [
              'app-server-a',
              'app-server-b',
              'app-server-c'
            ]
};


module.exports = config;
```

Once the failover has occured a message will be published to "postgres-high-availability-#{dbhost}" stating failover-complete. 
After that the sentinel will exit.

Managing a failover
-------------------

When a failover occurs postgres will rename recovery.conf to recovery.done. This is to ensure that if the new master is restarted it won't start as a slave.
The recovery.conf file should only exist on the slave, and any generated recovery.done file should be removed. 

It is important to delete the trigger file, because if it exists when a slave is brought up it can never
failover even if the file is deleted while running. The file cannot exist when postgres starts.

## TODO
 * allow multiple slaves to be selected from for failover
