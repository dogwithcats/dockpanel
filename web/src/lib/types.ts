export type ContainerState = 'created' | 'running' | 'paused' | 'restarting' | 'removing' | 'exited' | 'dead';

export interface Port {
  ip?: string;
  public: number | null;
  private: number;
  type: string;
}

export interface ContainerSummary {
  host: string;
  id: string;
  name: string;
  image: string;
  imageId: string;
  command: string;
  created: number;
  state: ContainerState;
  status: string;
  ports: Port[];
  networks: string[];
  project: string | null;
  service: string | null;
  protected: boolean;
}

export interface HostDockerInfo {
  name: string;
  serverVersion: string;
  os: string;
  kernel: string;
  arch: string;
  cpus: number;
  memTotal: number;
  containers: number;
  running: number;
  paused: number;
  stopped: number;
  images: number;
  storageDriver: string;
  dockerRootDir: string;
  warnings: string[];
}

export type HostType = 'local' | 'ssh' | 'tcp';

export interface HostStatus {
  state: 'online' | 'offline' | 'unknown';
  latency?: number;
  checkedAt?: number;
  error?: string;
  info?: HostDockerInfo;
}

export interface Host {
  id: string;
  name: string;
  type: HostType;
  address: string;
  createdAt: string;
  socketPath?: string;
  host?: string;
  port?: number;
  username?: string;
  authMethod?: 'key' | 'password';
  hasPrivateKey?: boolean;
  hasPassphrase?: boolean;
  hasPassword?: boolean;
  hostKey?: string | null;
  tls?: boolean;
  hasCerts?: boolean;
  status: HostStatus;
}

/** Payload for create / update / test. Empty secret fields keep the stored value on update. */
export interface HostInput {
  id?: string;
  name: string;
  type: HostType;
  socketPath?: string;
  host?: string;
  port?: number;
  username?: string;
  authMethod?: 'key' | 'password';
  privateKey?: string;
  passphrase?: string;
  password?: string;
  resetHostKey?: boolean;
  tls?: boolean;
  ca?: string;
  cert?: string;
  key?: string;
}

export interface HostTestResult {
  ok: true;
  latency: number;
  name: string;
  serverVersion: string;
  apiVersion: string;
  os: string;
  containers: number;
  running: number;
  fingerprint: string | null;
  fingerprintIsNew: boolean;
}

export interface ContainersResponse {
  items: ContainerSummary[];
  errors: { host: string; name: string; error: string }[];
}

export interface Me {
  user: string;
  readOnly: boolean;
  allowExec: boolean;
}

export interface AuditEntry {
  time: string;
  user?: string;
  ip?: string;
  action: string;
  host?: string;
  hostName?: string;
  target?: string;
  targetName?: string;
  ok: boolean;
  detail?: string;
}

export interface Stats {
  time: number;
  cpuPercent: number;
  cpus: number;
  memUsage: number;
  memLimit: number;
  memPercent: number;
  netRx: number;
  netTx: number;
  blkRead: number;
  blkWrite: number;
  pids: number;
}

/** Subset of `docker inspect` we render. */
export interface ContainerInspect {
  Id: string;
  Name: string;
  Created: string;
  Path: string;
  Args: string[];
  RestartCount: number;
  State: {
    Status: ContainerState;
    Running: boolean;
    Paused: boolean;
    Restarting: boolean;
    OOMKilled: boolean;
    Dead: boolean;
    Pid: number;
    ExitCode: number;
    Error: string;
    StartedAt: string;
    FinishedAt: string;
    Health?: { Status: string; FailingStreak: number; Log?: { Output: string; ExitCode: number; End: string }[] };
  };
  Image: string;
  Config: {
    Hostname: string;
    User: string;
    Env: string[] | null;
    Cmd: string[] | null;
    Entrypoint: string[] | null;
    Image: string;
    WorkingDir: string;
    Labels: Record<string, string> | null;
    Tty: boolean;
  };
  HostConfig: {
    RestartPolicy?: { Name: string; MaximumRetryCount: number };
    NetworkMode: string;
    Memory: number;
    NanoCpus: number;
    Privileged: boolean;
    PortBindings?: Record<string, { HostIp: string; HostPort: string }[] | null> | null;
  };
  Mounts: { Type: string; Name?: string; Source: string; Destination: string; Mode: string; RW: boolean }[];
  NetworkSettings: {
    Ports?: Record<string, { HostIp: string; HostPort: string }[] | null> | null;
    Networks?: Record<string, { IPAddress: string; Gateway: string; MacAddress: string; Aliases: string[] | null }>;
  };
}

/* ------------------------------------------------------------- file browser */

export interface FileMount {
  type: string;
  source: string;
  target: string;
  rw: boolean;
  name: string | null;
  browsable: boolean;
  reason: string | null;
}

export interface FileMounts {
  mounts: FileMount[];
  readOnly: boolean;
  canWrite: boolean;
  maxEditBytes: number;
}

export interface FileEntry {
  name: string;
  type: 'file' | 'dir' | 'link' | 'special';
  size: number;
  uid: string;
  gid: string;
  mode: number;
  mtime: number | null;
  exec: boolean;
  linkTarget: string | null;
}

export interface FileListing {
  path: string;
  entries: FileEntry[];
  truncated: boolean;
}

export interface FileContent {
  path: string;
  size: number;
  binary: boolean;
  readOnly: boolean;
  content: string | null;
}

export type ContainerAction = 'start' | 'stop' | 'restart' | 'pause' | 'unpause' | 'kill' | 'remove';
