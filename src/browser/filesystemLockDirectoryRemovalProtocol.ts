export interface DirectoryRemovalIdentity {
  readonly device: string;
  readonly inode: string;
  readonly birthtimeNs: string;
}

export interface DirectoryRemovalGoMessage {
  readonly type: "go";
  readonly token: string;
}

export interface DirectoryRemovalRootAttestation {
  readonly type: "attested";
  readonly token: string;
  readonly rootIdentity: DirectoryRemovalIdentity;
  readonly generationIdentity: DirectoryRemovalIdentity;
}

export interface DirectoryRemovalDirectoryAttestation {
  readonly type: "attested-directory";
  readonly token: string;
  readonly directoryIdentity: DirectoryRemovalIdentity;
  readonly mountId: null;
}

export interface DirectoryRemovalCompletedMessage {
  readonly type: "completed";
  readonly token: string;
}

export type DirectoryRemovalMessage =
  | DirectoryRemovalGoMessage
  | DirectoryRemovalRootAttestation
  | DirectoryRemovalDirectoryAttestation
  | DirectoryRemovalCompletedMessage;

export function encodeDirectoryRemovalMessage(message: DirectoryRemovalMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function parseDirectoryRemovalMessage(raw: string): DirectoryRemovalMessage {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error("Bound removal worker returned malformed protocol JSON", { cause: error });
  }
  if (!isPlainRecord(value) || typeof value.type !== "string" || typeof value.token !== "string") {
    throw new Error("Bound removal worker returned an invalid protocol message");
  }

  if (value.type === "go" || value.type === "completed") {
    if (!hasExactKeys(value, "token,type")) {
      throw new Error("Bound removal worker returned an invalid protocol message");
    }
    return { type: value.type, token: value.token };
  }

  if (value.type === "attested") {
    if (!hasExactKeys(value, "generationIdentity,rootIdentity,token,type")) {
      throw new Error("Bound removal worker returned an invalid root attestation");
    }
    const rootIdentity = parseDirectoryRemovalIdentity(value.rootIdentity);
    const generationIdentity = parseDirectoryRemovalIdentity(value.generationIdentity);
    if (rootIdentity === null || generationIdentity === null) {
      throw new Error("Bound removal worker returned an invalid root attestation");
    }
    return {
      type: "attested",
      token: value.token,
      rootIdentity,
      generationIdentity,
    };
  }

  if (value.type === "attested-directory") {
    if (!hasExactKeys(value, "directoryIdentity,mountId,token,type") || value.mountId !== null) {
      throw new Error("Bound removal worker returned an invalid directory attestation");
    }
    const directoryIdentity = parseDirectoryRemovalIdentity(value.directoryIdentity);
    if (directoryIdentity === null) {
      throw new Error("Bound removal worker returned an invalid directory attestation");
    }
    return {
      type: "attested-directory",
      token: value.token,
      directoryIdentity,
      mountId: null,
    };
  }

  throw new Error("Bound removal worker returned an invalid protocol message");
}

export function parseDirectoryRemovalIdentity(value: unknown): DirectoryRemovalIdentity | null {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, "birthtimeNs,device,inode") ||
    typeof value.device !== "string" ||
    typeof value.inode !== "string" ||
    typeof value.birthtimeNs !== "string" ||
    !/^(?:0|[1-9]\d*)$/u.test(value.device) ||
    !/^(?:0|[1-9]\d*)$/u.test(value.inode) ||
    !/^(?:0|[1-9]\d*)$/u.test(value.birthtimeNs)
  ) {
    return null;
  }
  return {
    device: value.device,
    inode: value.inode,
    birthtimeNs: value.birthtimeNs,
  };
}

export function sameDirectoryRemovalIdentity(
  left: DirectoryRemovalIdentity,
  right: DirectoryRemovalIdentity,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function hasExactKeys(value: Record<string, unknown>, expected: string): boolean {
  return Object.keys(value).sort().join(",") === expected;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
