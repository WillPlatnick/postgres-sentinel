rm /tmp/pgsql.trigger
rm /var/lib/pgsql/9.2/data/recovery.done
su -c "/var/lib/pgsql/run_backup.sh $1" postgres
su -c "/home/sofi/start_slave.sh $1" sofi

