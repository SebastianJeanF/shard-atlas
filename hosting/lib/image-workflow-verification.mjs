import {sha256} from '../../sync/protocol.mjs';
import {LibraryStorage} from '../../sync/storage.mjs';
import {scopeEnvironment} from './cloud-library-context.mjs';
import {readCloudLibrary} from './cloud-library-reader.mjs';
import {contributeCloudKnowledge, cloudMutationTransport} from './atlas-contributions.mjs';
import {editCloudKnowledge} from './atlas-edits.mjs';
import {resolveStagedImages} from './image-uploads.mjs';
import {registerAssetSource, assetDataHash} from './cloud-capsule.mjs';

export const IMAGE_VERIFY_NAME = 'shard_atlas_verify_image_workflow';
export const IMAGE_VERIFY_TOOL = {
  name: IMAGE_VERIFY_NAME,
  title: 'Verify the remote Shard Atlas image workflow',
  description: 'Use only for owner-authorized integration testing of image uploads. Takes an already verified owner-bound uploadId, creates and edits two synthetic technical notes in a fixed isolated test library, verifies the exact original image bytes and safe retries, and confirms that the personal library head did not change. Never saves test notes in the personal library. Reuse requestId after an uncertain outcome. This is an integration check, not a personal shard save.',
  inputSchema: {type: 'object', additionalProperties: false, required: ['requestId', 'uploadId'], properties: {
    requestId: {type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$'},
    uploadId: {type: 'string', pattern: '^image-upload-[a-f0-9]{64}$'},
  }},
  annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false},
};

export async function verifyImageWorkflow(env, args, {ownerId} = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).sort().join(',') !== 'requestId,uploadId'
      || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(args.requestId) || !/^image-upload-[a-f0-9]{64}$/.test(args.uploadId)
      || typeof ownerId !== 'string' || !ownerId) throw Error('Invalid integration check.');
  const digest = value => sha256(new TextEncoder().encode(value));
  const namespace = 'qa-image-' + await digest(ownerId), scoped = scopeEnvironment(env, namespace);
  const storage = new LibraryStorage(env.DB, env.BUCKET, namespace), personal = new LibraryStorage(env.DB, env.BUCKET);
  const personalHead = await personal.head(), suffix = (await digest(args.requestId)).slice(0, 24);
  const first = 'image-check-new-' + suffix, second = 'image-check-edit-' + suffix;
  const attachment = shardId => ({shardId, uploadId: args.uploadId, caption: 'Original integration-check image'});
  const current = await readCloudLibrary(scoped);
  const batch = {requestId: 'image-check-add-' + suffix, shards: [
    {id: first, title: 'Image verification: immutable bytes ' + suffix, content: 'A content hash identifies an exact byte sequence.', tags: ['integration-check']},
    {id: second, title: 'Image verification: atomic updates ' + suffix, content: 'An atomic update publishes the shard and its image reference together.', tags: ['integration-check']},
  ], links: [], images: [attachment(first)]};
  const added = await contributeCloudKnowledge(scoped, {batch, expectedRevision: current.revision}, {ownerId});
  const changes = {requestId: 'image-check-edit-' + suffix, shards: [{id: second, changes: {}}], links: [], images: [attachment(second)]};
  const edited = await editCloudKnowledge(scoped, {batch: changes, expectedRevision: added.currentRevision}, {ownerId});
  const beforeRetries = await storage.head();
  const addReplay = await contributeCloudKnowledge(scoped, {batch, expectedRevision: current.revision}, {ownerId});
  const editReplay = await editCloudKnowledge(scoped, {batch: changes, expectedRevision: added.currentRevision}, {ownerId});
  const retriesDidNotWrite = await storage.head() === beforeRetries;
  const accepted = await cloudMutationTransport.loadCurrent(storage), library = await readCloudLibrary(scoped);
  const [staged] = await resolveStagedImages(env, [attachment(first)], {ownerId});
  const expectedAsset = {...staged.asset};
  registerAssetSource(expectedAsset, {bytes: staged.source.bytes, sha256: staged.source.sha256,
    read: async () => {const object = await env.BUCKET.get(staged.source.key); if (!object) throw Error('Image unavailable.'); return object.body;}});
  const saved = accepted.capsule.archive.assets.find(asset => asset.id === staged.asset.id);
  const exactBytes = !!saved && await assetDataHash(saved) === await assetDataHash(expectedAsset);
  const referencesPresent = [first, second].every(id => library.archive.shards.some(shard => shard.id === id && shard.content.includes('/assets/' + staged.asset.id)));
  const personalLibraryUnchanged = await personal.head() === personalHead;
  const expectedLaterEdit = receipt => receipt.originalSaveVerified && receipt.changedShardIds?.length === 1
    && receipt.changedShardIds[0] === second && !receipt.missingShardIds?.length
    && !receipt.missingAssetIds?.length && !receipt.changedAssetIds?.length;
  const verified = (added.verified || added.replayed && expectedLaterEdit(added))
    && edited.verified && editReplay.verified && expectedLaterEdit(addReplay)
    && addReplay.replayed && editReplay.replayed && retriesDidNotWrite
    && exactBytes && referencesPresent && personalLibraryUnchanged;
  if (!verified) throw Error('Integration check could not be verified.');
  return {verified: true, isolatedTestLibrary: true, personalLibraryUnchanged, exactImageBytes: true,
    newShardImage: true, existingShardImage: true, idempotentRetries: true, assetId: staged.asset.id,
    sha256: staged.source.sha256, bytes: staged.source.bytes, readOnly: false};
}
