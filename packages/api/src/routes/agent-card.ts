/**
 * A small A2A-vocabulary discovery surface. It deliberately does not claim
 * wire-protocol compatibility: tasks travel through authenticated SMTP/API,
 * while this card only describes the capability and the email entrance.
 */

import { Hono } from 'hono';
import { config } from '../lib/config.ts';
import { findIdentity } from '../lib/identities.ts';

function cardEndpoint(address?: string): string {
  const candidate = address?.toLowerCase();
  // Do not enumerate private identity addresses from a public well-known
  // document. A caller that already knows an address may ask for its card.
  if (candidate && findIdentity(candidate)) return `mailto:${candidate}`;
  return `mailto:agent@${config.domain}`;
}

export const agentCardRoute = new Hono()
  .get('/agent-card.json', (c) => {
    const endpoint = cardEndpoint(c.req.query('address'));
    return c.json({
      name: 'openagent.email task agent',
      description: 'A self-hosted agent that accepts and updates email-backed task threads.',
      url: `${new URL(c.req.url).origin}/.well-known/agent-card.json`,
      version: '0.4',
      provider: { organization: 'openagent.email', url: 'https://openagent.email' },
      // A2A v1.0 uses a fixed capability object. Product-specific/free-form
      // capabilities stay in skills rather than turning this into a string list.
      capabilities: {
        streaming: false,
        pushNotifications: false,
        stateTransitionHistory: false,
      },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain', 'application/json'],
      skills: [{
        id: 'email-task-threads',
        name: 'Email task threads',
        description: 'Creates, receives and advances server-stamped task state through an email thread.',
        tags: ['email', 'task', 'a2a-vocabulary'],
        inputModes: ['text/plain'],
        outputModes: ['text/plain', 'application/json'],
      }],
      // This is an openagent.email extension used to express the actual
      // transport; it is not a statement of A2A HTTP protocol support.
      services: [{ name: 'email', endpoint }],
    });
  })
  .get('/agent-registration.json', (c) => c.json({
    version: '1.0',
    domain: config.domain,
    agentCard: `${new URL(c.req.url).origin}/.well-known/agent-card.json`,
    proof: {
      type: 'http-well-known-domain-control',
      domain: config.domain,
    },
  }));

