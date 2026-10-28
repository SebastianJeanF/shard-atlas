// Edits share the existing knowledge types, but contain sparse changes rather
// than replacement records. The engine validates each merged saved record.
import {CLOUD_BATCH_SCHEMA, CLOUD_IMAGES_SCHEMA} from './contribution-schema.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
function withoutNull(schema) {
  if (Array.isArray(schema)) return schema.map(withoutNull);
  if (!schema || typeof schema !== 'object') return schema;
  const result = {};
  for (const [key, value] of Object.entries(schema)) {
    result[key] = ['anyOf', 'oneOf'].includes(key)
      ? value.filter(option => option.type !== 'null').map(withoutNull)
      : withoutNull(value);
  }
  return result;
}
function sparseObject(schema) {
  const result = withoutNull(clone(schema));
  delete result.required;
  result.minProperties = 1;
  for (const [name, field] of Object.entries(result.properties || {})) {
    if (field.type === 'object' && field.properties) result.properties[name] = sparseObject(field);
    // Ordinary arrays are complete replacement values, so their entries retain
    // the full record schema rather than becoming ambiguous index patches.
    if (field.type === 'array') result.properties[name].description = [field.description,
      'When supplied, this array replaces the entire saved field. Include every entry to retain; omission leaves it unchanged.'].filter(Boolean).join(' ');
  }
  return result;
}

const shardSource = CLOUD_BATCH_SCHEMA.properties.shards.items;
const linkSource = CLOUD_BATCH_SCHEMA.properties.links.items;
const shardChanges = sparseObject(shardSource);
shardChanges.minProperties = 0;
delete shardChanges.properties.id;
shardChanges.properties.prompt = {type: 'string', maxLength: 10_000,
  description: 'The explicitly revised problem or study prompt. Omission preserves the saved prompt.'};
const linkChanges = sparseObject(linkSource);
delete linkChanges.properties.id;

const approachSource = shardSource.properties.codeSolution.properties.approaches.items;
const approachPatch = sparseObject(approachSource);
approachPatch.required = ['id'];
approachPatch.minProperties = 1;
approachPatch.properties.id.description = 'An existing stable approach ID to patch, or a new stable ID to append. Existing approach IDs cannot be changed.';
const approaches = shardChanges.properties.codeSolution.properties.approaches;
approaches.items = approachPatch;
approaches.description = 'Keyed upserts by stable id. Existing IDs receive sparse recursive changes while omitted fields, sibling approaches and order are preserved. A new ID appends an approach and requires a nonempty title and code. An empty list is a no-op. This tool cannot delete or reorder approaches.';

const idSchema = {...clone(shardSource.properties.id), description: 'The stable ID of an existing saved record. It is a target, not an editable field.'};
const item = (changes, description) => ({type: 'object', additionalProperties: false, required: ['id', 'changes'],
  properties: {id: clone(idSchema), changes: {...changes, description}}});

export const CLOUD_EDIT_BATCH_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['requestId', 'shards', 'links'],
  description: 'One atomic edits-only batch. Include at least one shard or connection change, or verified image attachment targeting an explicitly listed existing shard. Omitted fields are preserved. No new shards/connections, deletes, IDs, timestamps, or review metadata. Images must be uploaded separately first.',
  properties: {
    requestId: {...clone(CLOUD_BATCH_SCHEMA.properties.requestId), description: 'Unique stable identifier for this exact edit batch. Retry the identical batch and request ID after uncertain outcomes; never reuse the ID for different edits or additions.'},
    images: {...clone(CLOUD_IMAGES_SCHEMA), description: 'Ordered image attachments to existing shard IDs explicitly included in this edit batch. An image-only target may use changes:{}. Verified upload IDs and descriptors remain unchanged on retry.'},
    shards: {type: 'array', maxItems: 20, items: item(shardChanges,
      'Sparse changes to this existing shard. Objects merge recursively. Omitted optional fields remain unchanged; explicitly supplied ordinary arrays replace the saved field. codeSolution.approaches uses keyed upserts instead.')},
    links: {type: 'array', maxItems: 100, items: item(linkChanges,
      'Sparse changes to this existing saved connection. Omitted endpoints, approach IDs, direction, explanation, scope and sources remain unchanged. Endpoints must remain valid after the complete batch.')},
  },
};
