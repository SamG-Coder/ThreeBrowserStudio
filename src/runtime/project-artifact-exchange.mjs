import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { contentHash } from '../core/util.mjs';
import { StudioError } from '../core/errors.mjs';
import { synchronizeJsonSource } from './json-artifact.mjs';

const MAX_ARTIFACT_BYTES = 1_048_576;
const REFERENCE_PATTERN = /^(?![A-Za-z]:)(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fail(code, message, details) {
  throw new StudioError(code, message, details);
}

async function trustedRoot(repositoryRoot) {
  if (typeof repositoryRoot !== 'string' || repositoryRoot.trim() === '') fail('artifact_exchange_not_configured', 'Artifact exchange requires a configured repository root.');
  const supplied = path.resolve(repositoryRoot);
  const parsed = path.parse(supplied);
  let current = parsed.root;
  for (const segment of path.relative(parsed.root, supplied).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const info = await lstat(current).catch(() => fail('artifact_root_invalid', 'Configured artifact root could not be inspected.'));
    if (info.isSymbolicLink()) fail('artifact_path_reparse', 'Configured artifact root must not traverse a reparse point.');
    if (!info.isDirectory()) fail('artifact_root_invalid', 'Configured artifact root must be a directory.');
  }
  return realpath(supplied);
}

async function containedFile(repositoryRoot, reference) {
  if (typeof reference !== 'string' || !REFERENCE_PATTERN.test(reference)) {
    fail('artifact_path_invalid', 'Artifact paths must be normalized repository-relative paths.', { reference });
  }
  const root = await trustedRoot(repositoryRoot);
  let current = root;
  for (const segment of reference.split('/')) {
    current = path.join(current, segment);
    const info = await lstat(current).catch(error => {
      if (error.code === 'ENOENT') fail('artifact_not_found', 'Artifact file was not found.', { reference });
      throw error;
    });
    if (info.isSymbolicLink()) fail('artifact_path_reparse', 'Artifact paths must not traverse a reparse point.', { reference });
  }
  const canonical = await realpath(current);
  const relative = path.relative(root, canonical);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('artifact_path_invalid', 'Artifact path escaped the configured repository root.', { reference });
  }
  const info = await stat(canonical);
  if (!info.isFile()) fail('artifact_not_found', 'Artifact reference must identify a regular file.', { reference });
  if (info.size > MAX_ARTIFACT_BYTES) fail('artifact_too_large', `JSON artifacts may not exceed ${MAX_ARTIFACT_BYTES} bytes.`, { reference, bytes: info.size });
  return canonical;
}

function assertArtifact(artifact, expectedArtifactHash) {
  if (artifact?.kind !== 'jsonArtifact' || artifact.mediaType !== 'application/json'
      || artifact.document === null || typeof artifact.document !== 'object' || Array.isArray(artifact.document)) {
    fail('invalid_artifact_target', 'Artifact export requires a canonical JSON artifact.');
  }
  const actualArtifactHash = contentHash(artifact);
  if (actualArtifactHash !== expectedArtifactHash) {
    fail('artifact_hash_mismatch', 'Artifact changed after it was inspected.', { expectedArtifactHash, actualArtifactHash });
  }
}

export function createProjectArtifactExchange({ repositoryRoot } = {}) {
  return Object.freeze({
    configured: typeof repositoryRoot === 'string' && repositoryRoot.trim() !== '',
    async importArtifact({ reference, artifactId, name, schemaId, expectedFileSha256 }) {
      const filePath = await containedFile(repositoryRoot, reference);
      const bytes = await readFile(filePath);
      const fileSha256 = digest(bytes);
      if (fileSha256 !== expectedFileSha256) {
        fail('artifact_file_hash_mismatch', 'Artifact source bytes do not match the expected SHA-256.', {
          reference, expectedFileSha256, actualFileSha256: fileSha256,
        });
      }
      let document;
      try {
        document = JSON.parse(bytes.toString('utf8'));
      } catch (error) {
        fail('artifact_json_invalid', `Artifact source is not valid JSON: ${error.message}`, { reference });
      }
      if (document === null || typeof document !== 'object' || Array.isArray(document)) {
        fail('artifact_json_invalid', 'Artifact source must contain a JSON object.', { reference });
      }
      const artifact = {
        id: artifactId,
        kind: 'jsonArtifact',
        name: name ?? artifactId.split('/').at(-1),
        mediaType: 'application/json',
        schemaId,
        document,
        sourceText: bytes.toString('utf8'),
        metadata: { importedFrom: reference, importedFileSha256: fileSha256 },
      };
      return { artifact, fileSha256, artifactHash: contentHash(artifact), reference };
    },
    async exportArtifact({ reference, artifact, expectedArtifactHash, expectedFileSha256 }) {
      assertArtifact(artifact, expectedArtifactHash);
      const filePath = await containedFile(repositoryRoot, reference);
      const before = await readFile(filePath);
      const actualFileSha256 = digest(before);
      if (actualFileSha256 !== expectedFileSha256) {
        fail('artifact_file_hash_mismatch', 'Artifact destination changed after it was inspected.', {
          reference, expectedFileSha256, actualFileSha256,
        });
      }
      const sourceText = synchronizeJsonSource(artifact.sourceText, artifact.document);
      const bytes = Buffer.from(sourceText, 'utf8');
      if (bytes.length > MAX_ARTIFACT_BYTES) fail('artifact_too_large', `JSON artifacts may not exceed ${MAX_ARTIFACT_BYTES} bytes.`, { reference, bytes: bytes.length });
      const fileSha256 = digest(bytes);
      const changed = !before.equals(bytes);
      if (changed) {
        const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
          await rename(temporary, filePath);
        } catch (error) {
          await unlink(temporary).catch(() => {});
          throw error;
        }
      }
      return { reference, fileSha256, artifactHash: expectedArtifactHash, changed, bytes: bytes.length };
    },
  });
}
