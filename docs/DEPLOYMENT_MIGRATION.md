# Production data-volume migration

`deploy/docker-compose.prod.yml` now mounts the stable Docker volume
`misaka_data` at `/app/data`. The explicit volume name is also the name used by
the backup commands, regardless of the checkout directory or Compose project
name.

## Existing named-volume deployment

If `docker volume inspect misaka_data` succeeds, no migration is needed. Stop
the stack, take a backup, deploy the new Compose file, then confirm
`turn-state.json` and `auth-locks.json` exist in the mounted volume.

## Older anonymous-volume deployment

Older images declared `/app/data` as an anonymous volume. Do this once before
removing the old container:

1. Identify the old container and its exact `/app/data` volume:

   ```bash
   docker inspect misaka-signaling \
     --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}'
   ```

2. Stop the old container. Replace `OLD_VOLUME` below with the inspected,
   non-empty name, create the stable target, and copy the data:

   ```bash
   docker stop misaka-signaling
   docker volume create misaka_data
   docker run --rm -v OLD_VOLUME:/source:ro -v misaka_data:/target \
     alpine sh -c 'cp -a /source/. /target/'
   ```

3. Start the new stack and verify readiness plus both snapshots:

   ```bash
   docker compose -f deploy/docker-compose.prod.yml up -d --build
   docker run --rm -v misaka_data:/data:ro alpine \
     sh -c 'test -s /data/turn-state.json && test -s /data/auth-locks.json'
   ```

Keep the old volume until the new server is healthy and the monthly TURN
counter, revoke queue, and abuse locks look correct. Removing that old volume
is a separate, destructive operator decision.

