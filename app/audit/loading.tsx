export default function AuditLoading() {
  return (
    <div className="space-y-5 p-6" role="status" aria-label="Loading audit history">
      <span className="sr-only">Loading audit history</span>
      <div className="skeleton h-8 w-48" />
      <div className="skeleton h-40 w-full" />
      {[1, 2, 3].map((row) => (
        <div key={row} className="skeleton h-20 w-full" />
      ))}
    </div>
  );
}
