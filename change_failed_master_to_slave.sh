rm /tmp/pgsql.trigger
rm /var/lib/pgsql/9.2/data/recovery.done
cp /var/lib/pgsql/9.2/data/_recovery.conf /var/lib/pgsql/9.2/data/recovery.conf
cp /var/lib/pgsql/9.2/data/_postgresql.conf /var/lib/pgsql/9.2/data/postgresql.conf
chown postgres:postgres /var/lib/pgsql/9.2/data/recovery.conf
chown postgres:postgres /var/lib/pgsql/9.2/data/postgresql.conf
