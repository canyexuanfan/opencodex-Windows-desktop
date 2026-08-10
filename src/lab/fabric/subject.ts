import { domainHash, jcsStringify, subjectIdForSubject } from "../digest";
import type { RouteSubjectV1, TaskSubjectV1 } from "../events/types";
import { freezeRouteSubject } from "../subject/route-subject";
import {
  FABRIC_COMPATIBILITY_VERSION,
  FABRIC_TASK_CLASS_ID,
  FABRIC_TASK_CLASS_VERSION,
  FABRIC_VERIFIER_ID,
  SANDBOX_PROFILE_V1,
  SYNTHETIC_AFTER_UTF8,
  SYNTHETIC_BEFORE_UTF8,
  SYNTHETIC_VALUE_PATH,
} from "./constants";

const SANDBOX_DOMAIN = "ocx-lab:fabric-sandbox-profile:v1";
const VERIFIER_DOMAIN = "ocx-lab:fabric-verifier-manifest:v1";
const FIXTURE_DOMAIN = "ocx-lab:fabric-task-fixture:v1";

export function sandboxProfileDigest(profile: unknown = SANDBOX_PROFILE_V1): string {
  return domainHash(SANDBOX_DOMAIN, jcsStringify(profile));
}

export function verifierManifestObject(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    verifierId: FABRIC_VERIFIER_ID,
    sort: "utf8-bytes-posix-path",
    rejectSymlinks: true,
    rejectSpecialFiles: true,
    rejectPathTraversal: true,
    allowAdds: false,
    allowDeletes: false,
    allowRenames: false,
    requiredChange: {
      path: SYNTHETIC_VALUE_PATH,
      beforeUtf8: SYNTHETIC_BEFORE_UTF8,
      afterUtf8: SYNTHETIC_AFTER_UTF8,
    },
  };
}

export function verifierManifestDigest(manifest: unknown = verifierManifestObject()): string {
  return domainHash(VERIFIER_DOMAIN, jcsStringify(manifest));
}

export function taskFixtureObject(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    taskClassId: FABRIC_TASK_CLASS_ID,
    taskClassVersion: FABRIC_TASK_CLASS_VERSION,
    files: [
      {
        path: SYNTHETIC_VALUE_PATH,
        contentUtf8: SYNTHETIC_BEFORE_UTF8,
      },
    ],
    requestedFinal: [
      {
        path: SYNTHETIC_VALUE_PATH,
        contentUtf8: SYNTHETIC_AFTER_UTF8,
      },
    ],
  };
}

export function taskFixtureDigest(fixture: unknown = taskFixtureObject()): string {
  return domainHash(FIXTURE_DOMAIN, jcsStringify(fixture));
}

export function buildTaskSubjectV1(input: {
  routeSubject: RouteSubjectV1;
  taskClassId?: string;
  taskClassVersion?: string;
  taskFixtureDigest?: string;
  verifierManifestDigest?: string;
  fabricCompatibilityVersion?: string;
  sandboxProfileDigest?: string;
}): TaskSubjectV1 {
  const routeSubject = freezeRouteSubject(input.routeSubject);
  const subject: TaskSubjectV1 = {
    subjectSchemaVersion: 1,
    subjectKind: "task",
    routeSubject,
    taskClassId: input.taskClassId ?? FABRIC_TASK_CLASS_ID,
    taskClassVersion: input.taskClassVersion ?? FABRIC_TASK_CLASS_VERSION,
    taskFixtureDigest: input.taskFixtureDigest ?? taskFixtureDigest(),
    verifierManifestDigest: input.verifierManifestDigest ?? verifierManifestDigest(),
    fabricCompatibilityVersion: input.fabricCompatibilityVersion ?? FABRIC_COMPATIBILITY_VERSION,
    sandboxProfileDigest: input.sandboxProfileDigest ?? sandboxProfileDigest(),
  };
  return Object.freeze({
    ...subject,
    routeSubject: freezeRouteSubject(subject.routeSubject),
  });
}

export function taskSubjectId(subject: TaskSubjectV1): string {
  return subjectIdForSubject(subject);
}
