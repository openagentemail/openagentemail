# File task listener

This is a deliberately small reference listener for a managed agent identity.
It polls the server-side notification route, then writes tasks addressed to
that identity into `task-inbox.json`. Another local process can read that file,
do the work, and call `task_update` through its MCP client.

It does not contain an ntfy topic, a device token, a mail password, or cmux
integration. The API keeps the notification routing and credentials on the
server; this example only needs the identity's scoped API token.

```bash
export OPENAGENTEMAIL_API_URL=http://localhost:3100
export OPENAGENTEMAIL_API_KEY=oa_...
export OPENAGENTEMAIL_IDENTITY_ADDRESS=worker@example.com
node examples/listener/listener.mjs
```

The output file is owner-readable only. Keep it out of a shared directory if
task bodies may contain sensitive material.

