import { DomainError } from './errors.js';

export interface Transition<S extends string, E extends string> {
  readonly event: E;
  readonly from: readonly S[];
  readonly to: S;
  /** The actor must give a reason (stored in the audit log). */
  readonly requiresReason?: boolean;
  /** Needs a manager PIN override when the actor is not a manager (AUTH-011). */
  readonly requiresManagerOverride?: boolean;
}

export interface StateMachine<S extends string, E extends string> {
  readonly name: string;
  readonly states: readonly S[];
  readonly terminal: readonly S[];
  readonly transitions: readonly Transition<S, E>[];
}

/** Defines a state machine and checks it is consistent (no duplicate event from the same state). */
export function defineStateMachine<S extends string, E extends string>(
  machine: StateMachine<S, E>,
): StateMachine<S, E> {
  const known = new Set<string>(machine.states);
  const seen = new Set<string>();
  for (const transition of machine.transitions) {
    if (!known.has(transition.to)) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        `${machine.name}: unknown target state ${transition.to}`,
      );
    }
    for (const from of transition.from) {
      if (!known.has(from)) {
        throw new DomainError('INVALID_ARGUMENT', `${machine.name}: unknown source state ${from}`);
      }
      if (machine.terminal.includes(from)) {
        throw new DomainError(
          'INVALID_ARGUMENT',
          `${machine.name}: terminal state ${from} has a transition`,
        );
      }
      const key = `${from}|${transition.event}`;
      if (seen.has(key)) {
        throw new DomainError('INVALID_ARGUMENT', `${machine.name}: duplicate transition ${key}`);
      }
      seen.add(key);
    }
  }
  return machine;
}

export function findTransition<S extends string, E extends string>(
  machine: StateMachine<S, E>,
  from: S,
  event: E,
): Transition<S, E> | undefined {
  return machine.transitions.find(
    (transition) => transition.event === event && transition.from.includes(from),
  );
}

export function canTransition<S extends string, E extends string>(
  machine: StateMachine<S, E>,
  from: S,
  event: E,
): boolean {
  return findTransition(machine, from, event) !== undefined;
}

/** Returns the transition or throws INVALID_TRANSITION. */
export function transition<S extends string, E extends string>(
  machine: StateMachine<S, E>,
  from: S,
  event: E,
): Transition<S, E> {
  const found = findTransition(machine, from, event);
  if (!found) {
    throw new DomainError('INVALID_TRANSITION', `${machine.name}: cannot ${event} from ${from}`, {
      machine: machine.name,
      from,
      event,
    });
  }
  return found;
}

export function allowedEvents<S extends string, E extends string>(
  machine: StateMachine<S, E>,
  from: S,
): E[] {
  return machine.transitions
    .filter((candidate) => candidate.from.includes(from))
    .map((candidate) => candidate.event);
}

export function isTerminal<S extends string, E extends string>(
  machine: StateMachine<S, E>,
  state: S,
): boolean {
  return machine.terminal.includes(state);
}
