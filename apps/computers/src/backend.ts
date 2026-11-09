/**
 * Where Computers run. Docker is the first backend (local, Linux only); cloud backends
 * plug in behind the same interface later.
 */
export interface ComputerBackend {
  /** Creates the Computer and starts it. */
  create(computer: { id: string; owner: string; agentToken: string }): Promise<BackendComputer>;
  /** Null when there is no such Computer. */
  find(id: string): Promise<BackendComputer | null>;
  start(id: string): Promise<void>;
  /** Keeps the disk and drops memory. */
  shutDown(id: string): Promise<void>;
  /** Deletes the Computer and its disk. */
  remove(id: string): Promise<void>;
  /** Where the Computer service reaches the Computer agent; null unless the Computer is running. */
  agentAddress(id: string): Promise<{ host: string; port: number } | null>;
}

export type ComputerState = "running" | "asleep" | "shut_down";

export interface BackendComputer {
  id: string;
  /** Whom the Computer belongs to, as the Bot service names them. */
  owner: string;
  state: ComputerState;
  /** The secret this Computer's agent accepts, and no other agent does. */
  agentToken: string;
}

/** The port the Computer agent listens on inside every Computer. */
export const AGENT_PORT = 4000;
