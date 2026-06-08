// conduit — the authorization kernel for AI agents.
//
// Package entry point. Everything an agent harness needs:
//
//   import { Conduit } from 'conduit';
//
//   const conduit = new Conduit({
//     rules: [{ action: 'payment.*', behavior: 'ask' }],
//   });
//
//   const outcome = await conduit.run(
//     { agentId, action: 'payment.charge', input, cost },
//     async () => chargeTheCard(input),
//   );
//
// The full kernel surface is re-exported from ./kernel.

export * from './kernel/index.ts';
