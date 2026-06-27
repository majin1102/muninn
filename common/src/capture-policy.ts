import type {
  AgentName,
  CanonicalProjectIdentity,
  MuninnSessionKey,
} from './session-identity';

export type CapturePolicyFile = {
  capture?: {
    agents?: Record<AgentName, boolean>;
    projects?: Record<AgentName, Record<CanonicalProjectIdentity, boolean>>;
    sessions?: Record<MuninnSessionKey, boolean>;
  };
};

export type CaptureProgressFile = {
  sessions?: Record<MuninnSessionKey, {
    agent: AgentName;
    project: CanonicalProjectIdentity;
    cwd: string;
    sessionId: string;
    transcriptPath: string;
    lastTurnSequence?: number;
    byteOffset?: number;
    eventIndex?: number;
    updatedAt: string;
  }>;
};

