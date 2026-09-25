import { z } from 'zod';
import {
  collectSchemas,
  type JsonSchema,
  pruneToReachable,
  toJsonSchemas,
} from './schema-catalog.js';

export interface AsyncApiOptions {
  /** The package namespace; event schemas and the schemas they use get their export names. */
  namespace: Readonly<Record<string, unknown>>;
  /** The domain event catalogue (the discriminated union of every event). */
  events: z.ZodDiscriminatedUnion;
  version: string;
}

interface EventInfo {
  type: string;
  version: number;
  schema: z.ZodType;
}

/** Builds the AsyncAPI 3.1 document for the domain event catalogue (INT-002, INT-004). */
export function buildAsyncApi({ namespace, events, version }: AsyncApiOptions): JsonSchema {
  const named = collectSchemas(namespace);
  const nameOf = new Map([...named].map(([name, schema]) => [schema, name]));
  const catalogue = events.options.map(eventInfo);

  const payloadNames = new Map<string, string>();
  for (const event of catalogue) {
    let name = nameOf.get(event.schema);
    if (name === undefined) {
      // An event that is only defined inside the union is named after its type.
      if (named.has(event.type)) throw new Error(`Event ${event.type} collides with an export`);
      name = event.type;
      named.set(name, event.schema);
    }
    payloadNames.set(event.type, name);
  }
  const schemas = pruneToReachable(toJsonSchemas(named, 'output'), payloadNames.values());

  const channels: Record<string, unknown> = {};
  const operations: Record<string, unknown> = {};
  const messages: Record<string, unknown> = {};
  for (const event of catalogue) {
    if (channels[event.type] !== undefined) throw new Error(`Duplicate event type ${event.type}`);
    channels[event.type] = {
      address: event.type,
      messages: { [event.type]: { $ref: `#/components/messages/${event.type}` } },
    };
    operations[`receive${event.type}`] = {
      action: 'receive',
      channel: { $ref: `#/channels/${event.type}` },
      messages: [{ $ref: `#/channels/${event.type}/messages/${event.type}` }],
    };
    messages[event.type] = {
      name: event.type,
      title: `${event.type} v${event.version}`,
      contentType: 'application/json',
      payload: { $ref: `#/components/schemas/${payloadNames.get(event.type) ?? event.type}` },
    };
  }

  return {
    asyncapi: '3.1.0',
    info: {
      title: 'Restaurant Operations Platform: domain events',
      version,
      description:
        'Generated from @rp/contracts by `pnpm contracts:docs`; do not edit by hand. Every domain ' +
        'event shares one envelope (eventId, type, version, occurredAt, restaurantId, ' +
        'businessDate, correlationId, payload) and is versioned so consumers can support the ' +
        'current and previous version (UPD-006). Channel addresses are event types; the ' +
        'transports that carry them (Socket.io to apps, MQTT to pagers, the outbox to the cloud) ' +
        'map these names to their own rooms and topics. On Socket.io (namespace /rt) each event ' +
        'arrives as a RealtimeEvent message { sequence, event }, filtered to the rooms allowed to ' +
        'see it; the handshake, resync and full-refresh protocol is in @rp/contracts realtime.ts.',
    },
    defaultContentType: 'application/json',
    channels,
    operations,
    components: { messages, schemas },
  };
}

function eventInfo(option: z.core.$ZodType): EventInfo {
  if (!(option instanceof z.ZodObject)) throw new Error('Every domain event must be an object');
  const { type, version } = option.shape as Record<string, unknown>;
  if (!(type instanceof z.ZodLiteral) || typeof type.value !== 'string') {
    throw new Error('Every domain event needs a string literal `type`');
  }
  if (!(version instanceof z.ZodLiteral) || typeof version.value !== 'number') {
    throw new Error(`Event ${type.value} needs a numeric literal \`version\``);
  }
  return { type: type.value, version: version.value, schema: option };
}
