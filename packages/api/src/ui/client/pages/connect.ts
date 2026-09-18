/**
 * Connect-agent page browser source loader.
 * The adjacent .js file is copied into dist/ui and read at runtime.
 */
import { readUiSibling } from '../../load-ui-asset.ts';

export const CONNECT_PAGE_JS = readUiSibling(import.meta.url, 'connect.js');
