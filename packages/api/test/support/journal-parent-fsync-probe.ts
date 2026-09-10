// Bootstrap probe: run under an external syscall tracer. Sets an isolated
// DATA_DIR (argv[2]) and performs one genuine first provision, so the tracer
// can observe the real fsync syscalls in order.
process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = process.argv[2];
process.env.TASK_LEASES_ENABLED = 'true';

const { bootstrapTaskLeaseJournal } = await import('../../src/lib/task-lease-journal.ts');
try {
  bootstrapTaskLeaseJournal();
  console.log('BOOTSTRAP_OK');
} catch (err) {
  console.log(`BOOTSTRAP_FAIL ${(err as Error).message}`);
  process.exit(1);
}
