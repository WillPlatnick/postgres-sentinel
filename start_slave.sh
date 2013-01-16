ssh -tt -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no $1 sudo /var/lib/pgsql/change_failed_master_to_slave.sh
ssh -tt -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no $1 sudo /etc/init.d/postgresql-9.2 start
