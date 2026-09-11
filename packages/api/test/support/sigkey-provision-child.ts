// Child-side provisioning: fresh process -> fresh config from the explicit env.
const { bootstrapTaskLeaseJournal, setJournalDataDirForTests } = await import('../../src/lib/task-lease-journal.ts');
const dataDir = process.argv[2];
if (!dataDir) {
  console.error('missing data dir');
  process.exit(2);
}
const stallMs = Number(process.env.OAE_PROVISION_STALL_MS ?? 0);
if (stallMs > 0) await new Promise((resolve) => setTimeout(resolve, stallMs));
setJournalDataDirForTests(dataDir);
bootstrapTaskLeaseJournal();
console.log('PROVISION_OK');
