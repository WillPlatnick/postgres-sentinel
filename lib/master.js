var _ = require('underscore');

var config = {
  dbname: "sofi_production"
  , dbuser: "sofi"
  , dbpass: "octanitrocubane"
  , dbhost: "192.168.33.10"
  , dbport: 5432
  , dbslave: "192.168.33.11"
  , redis_host: "192.168.33.11"
  , redis_port: 6379
  , monitoring_master: true
  , interval: 5000
  , dbhostname: "yyc-sofidevdb"
  , db_failover_trigger_file: "/tmp/pgsql.trigger"
  , required_sdown: 2
  , snmp_trigger_file: "/tmp/snmp.trigger"
  , host_list: [
      '192.168.33.10',
      '192.168.33.11'
               ]
};


module.exports = config; //_.extend({}, config, override);
