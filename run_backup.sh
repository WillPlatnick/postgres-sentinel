psql -c "SELECT pg_start_backup('clone', true);"
rsync -a -e "ssh -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no" /var/lib/pgsql/9.2/data/ $1:/var/lib/pgsql/9.2/data/ --exclude postmaster.pid --exclude postgresql.conf --exclude _recovery.conf --exclude recovery.done;
psql -c "SELECT pg_stop_backup();"
