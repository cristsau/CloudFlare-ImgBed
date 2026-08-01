/**
 * KV getWithMetadata returns { value: null, metadata: null } for a missing key,
 * while some adapters return null. Treat both representations as idempotently
 * deleted.
 */
export function isMissingStoredFile(record) {
    if (record === null || record === undefined) return true;

    return typeof record === 'object'
        && Object.prototype.hasOwnProperty.call(record, 'value')
        && record.value === null
        && (record.metadata === null || record.metadata === undefined);
}
