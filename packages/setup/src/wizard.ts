import type { CliOptions } from './args.ts';
import { runConnect } from './connect.ts';
import type { ClientContext } from './clients.ts';
import { runDemo, type DemoRuntime } from './demo.ts';
import {
  loadRecommendations,
  recommendationLine,
  recommendedVps,
} from './recommendations.ts';
import type { Reporter } from './reporter.ts';
import {
  clearSetupState,
  readSetupState,
  setupStatePath,
  writeSetupState,
} from './state.ts';
import type { CliResult, PromptAdapter } from './types.ts';
import { offerPhonePairing } from './phone.ts';

async function connectAndOfferPhone(
  options: CliOptions,
  prompts: PromptAdapter,
  reporter: Reporter,
  dependencies: WizardDependencies,
  statePath: string,
): Promise<Omit<CliResult, 'ok' | 'warnings'>> {
  const result = await runConnect(options, prompts, reporter, {
    fetcher: dependencies.fetcher,
    clientContext: dependencies.clientContext,
    verifyMcp: dependencies.verifyMcp,
    statePath,
  });
  await offerPhonePairing(prompts, reporter, { fetcher: dependencies.fetcher });
  return result;
}

type WizardDependencies = {
  fetcher?: typeof fetch;
  clientContext?: ClientContext;
  demoRuntime?: DemoRuntime;
  verifyMcp?: (apiUrl: string, token: string) => Promise<void>;
  statePath?: string;
};

async function saveShoppingProgress(
  reporter: Reporter,
  statePath: string,
): Promise<Omit<CliResult, 'ok' | 'warnings'>> {
  await writeSetupState({ stage: 'recommendations' }, statePath);
  reporter.info('Progress saved. Run the setup command again when your server is ready.');
  return { configuredClients: [] };
}

async function continueSavedState(
  options: CliOptions,
  prompts: PromptAdapter,
  reporter: Reporter,
  dependencies: WizardDependencies,
  statePath: string,
): Promise<Omit<CliResult, 'ok' | 'warnings'>> {
  const next = await prompts.select('What would you like to do now?', [
    { value: 'connect', label: 'I have deployed the server — connect it' },
    { value: 'save', label: 'Keep my progress and exit' },
  ], 'connect');
  if (next === 'save') return saveShoppingProgress(reporter, statePath);
  return connectAndOfferPhone(options, prompts, reporter, dependencies, statePath);
}

async function recommendationBranch(
  options: CliOptions,
  prompts: PromptAdapter,
  reporter: Reporter,
  dependencies: WizardDependencies,
  statePath: string,
  recommendationPromise: ReturnType<typeof loadRecommendations>,
): Promise<Omit<CliResult, 'ok' | 'warnings'>> {
  const hasVps = await prompts.confirm('Do you already have a VPS?', false);
  const hasDomain = await prompts.confirm(
    'Do you already own any domain you can reuse with a subdomain?',
    true,
  );
  const data = await recommendationPromise;

  if (!hasVps) {
    const needsAlipay = await prompts.confirm(
      'Do you need to pay with Alipay or WeChat Pay?',
      /Asia\/(Shanghai|Chongqing|Harbin|Urumqi)/.test(process.env.TZ || ''),
    );
    reporter.info('\nVPS options:');
    for (const item of recommendedVps(data, needsAlipay)) {
      reporter.info(`  ${recommendationLine(item)}`);
    }
    reporter.info(data.disclosure);
    reporter.info('Full comparison: https://openagent.email/docs/get-a-vps');
  }

  if (!hasDomain) {
    reporter.info(
      '\nAlready own ANY domain? Use a subdomain such as agents.example.com — there is usually nothing else to buy.',
    );
    const buyDomain = await prompts.confirm('Do you still need to buy a domain?', true);
    if (buyDomain) {
      reporter.info('\nDomain registrar options:');
      for (const item of data.registrars) {
        reporter.info(`  ${recommendationLine(item)}`);
      }
      reporter.info(data.disclosure);
      reporter.info(
        'For verification-only mail, inexpensive .xyz/.top domains can work. For human-facing mail, prefer .com and check the renewal price.',
      );
    }
  }

  const next = await prompts.select('When you are ready, what comes next?', [
    { value: 'connect', label: 'I already deployed the server — connect it now' },
    { value: 'save', label: 'Save progress and exit' },
  ], 'save');
  if (next === 'save') return saveShoppingProgress(reporter, statePath);
  return connectAndOfferPhone(options, prompts, reporter, dependencies, statePath);
}

export async function runWizard(
  options: CliOptions,
  prompts: PromptAdapter,
  reporter: Reporter,
  dependencies: WizardDependencies = {},
): Promise<Omit<CliResult, 'ok' | 'warnings'>> {
  const statePath = dependencies.statePath ?? setupStatePath();
  const recommendationPromise = loadRecommendations(
    options.noFetch,
    dependencies.fetcher ?? fetch,
  );
  const state = await readSetupState(statePath);

  if (state) {
    const shouldContinue = await prompts.confirm('Continue where you left off?', true);
    if (shouldContinue) {
      return continueSavedState(options, prompts, reporter, dependencies, statePath);
    }
    await clearSetupState(statePath);
  }

  const running = await prompts.confirm(
    'Do you already have a running openagent.email server?',
    false,
  );
  if (running) {
    return connectAndOfferPhone(options, prompts, reporter, dependencies, statePath);
  }

  const route = await prompts.select('What would you like to do?', [
    { value: 'recommend', label: 'Get VPS/domain recommendations' },
    { value: 'demo', label: 'Try a local demo' },
    { value: 'exit', label: 'Exit' },
  ], 'demo');
  if (route === 'exit') return { configuredClients: [] };
  if (route === 'demo') {
    return runDemo(options, prompts, reporter, dependencies.demoRuntime);
  }
  return recommendationBranch(
    options,
    prompts,
    reporter,
    dependencies,
    statePath,
    recommendationPromise,
  );
}
