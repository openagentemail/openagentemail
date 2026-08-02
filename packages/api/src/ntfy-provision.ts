/** One-shot Compose entrypoint: create ntfy config before ntfy starts. */
import { initializeNotifications } from './lib/notify.ts';

await initializeNotifications();
