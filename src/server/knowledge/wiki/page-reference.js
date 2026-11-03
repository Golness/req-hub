/**
 * Match either a frozen Wiki evidence ID or its persisted page ID.
 * @param records - Authorized frozen documents or their manifest entries.
 * @param key - The model-provided page reference.
 * @returns The matching Wiki record; source and control documents never match.
 */
export function findWikiPage(records, key) {
  return records.find(
    (record) =>
      record.kind === 'wiki' &&
      typeof record.pageId === 'string' &&
      (record.id === key || record.pageId === key),
  );
}
