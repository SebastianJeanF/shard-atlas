// D1 owns the atomic head update; R2 objects are immutable and content addressed.
// Deploy schema.sql as a migration before serving requests. Never create schema here.
export class LibraryStorage {
  constructor(database, bucket, libraryId = 'owner') {
    this.database = database;
    this.bucket = bucket;
    this.libraryId = libraryId;
  }

  key(hash) { return `libraries/${this.libraryId}/blobs/${hash}`; }
  async blob(hash) { return this.bucket.get(this.key(hash)); }
  async blobInfo(hash) { return this.bucket.head(this.key(hash)); }
  async putBlob(hash, bytes) {
    // Identical digests are interchangeable; retrying this write cannot alter data.
    await this.bucket.put(this.key(hash), bytes, {httpMetadata: {contentType: 'application/octet-stream'}});
  }
  async head() {
    const row = await this.database.prepare('SELECT revision FROM library_heads WHERE library_id = ?').bind(this.libraryId).first();
    return row?.revision || '';
  }
  async receipt(mutationId) {
    return this.database.prepare('SELECT * FROM library_commits WHERE library_id = ? AND mutation_id = ?').bind(this.libraryId, mutationId).first();
  }
  async commit(id) {
    return this.database.prepare('SELECT * FROM library_commits WHERE library_id = ? AND id = ?').bind(this.libraryId, id).first();
  }
  async history({conflicts = false, offset = 0} = {}) {
    const result = await this.database.prepare(`SELECT id, mutation_id, base_revision, status, observed_revision, created_at FROM library_commits WHERE library_id = ?${conflicts ? " AND status = 'conflict'" : ''} ORDER BY created_at DESC, id DESC LIMIT 51 OFFSET ?`).bind(this.libraryId, offset).all();
    const rows = result.results || [];
    return {items: rows.slice(0, 50).map(row => publicCommit(row)), nextCursor: rows.length > 50 ? String(offset + 50) : null};
  }
  async publish({id, mutationId, baseRevision, fingerprint, manifest, createdAt}) {
    // D1 batch is transactional. Concurrent callers observe a serialized head;
    // only a snapshot based on that head can become the next accepted revision.
    const prepare = sql => this.database.prepare(sql);
    const results = await this.database.batch([
      prepare('INSERT OR IGNORE INTO library_heads (library_id, revision) VALUES (?, ?)').bind(this.libraryId, ''),
      prepare(`INSERT OR IGNORE INTO library_commits (id, library_id, mutation_id, base_revision, fingerprint, manifest, status, observed_revision, created_at)
        SELECT ?, ?, ?, ?, ?, ?, CASE WHEN revision = ? THEN 'accepted' ELSE 'conflict' END, revision, ? FROM library_heads WHERE library_id = ?`).bind(id, this.libraryId, mutationId, baseRevision, fingerprint, JSON.stringify(manifest), baseRevision, createdAt, this.libraryId),
      prepare("UPDATE library_heads SET revision = ? WHERE library_id = ? AND revision = ? AND EXISTS (SELECT 1 FROM library_commits WHERE library_id = ? AND id = ? AND status = 'accepted')").bind(id, this.libraryId, baseRevision, this.libraryId, id),
      prepare('SELECT * FROM library_commits WHERE library_id = ? AND mutation_id = ?').bind(this.libraryId, mutationId),
    ]);
    return results[3].results[0];
  }
}

export function publicCommit(row, includeManifest = false) {
  if (!row) return null;
  return {id: row.id, mutationId: row.mutation_id, baseRevision: row.base_revision, status: row.status,
    observedRevision: row.observed_revision, createdAt: row.created_at,
    ...(includeManifest ? {manifest: JSON.parse(row.manifest)} : {})};
}
