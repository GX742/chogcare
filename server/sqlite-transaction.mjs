let savepointId = 0;

// Synchronous only. Nested savepoints let the outbox and budget ledger commit
// together without exposing a state where a send exists but its budget does not.
export function atomic(db, callback) {
  const nested = db.isTransaction;
  const name = `chogcare_${++savepointId}`;
  db.exec(nested ? `SAVEPOINT ${name}` : "BEGIN IMMEDIATE");
  try {
    const result = callback();
    if (result && typeof result.then === "function") throw new Error("Database transactions must not await network calls.");
    db.exec(nested ? `RELEASE ${name}` : "COMMIT");
    return result;
  } catch (error) {
    db.exec(nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : "ROLLBACK");
    throw error;
  }
}
