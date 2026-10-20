export function FlagPageLoading() {
  return (
    <main className="mx-auto max-w-[1200px] space-y-6 p-6" role="status" aria-busy="true">
      <span className="sr-only">Loading flags…</span>
      <div aria-hidden="true" className="space-y-6">
        <div className="skeleton h-8 w-48" />
        <div className="skeleton h-4 w-64 max-w-full" />
        <div className="space-y-5 rounded-card border border-border p-4">
          {Array.from({ length: 5 }, (_, index) => (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4" key={index}>
              {Array.from({ length: 4 }, (_, cell) => (
                <div key={cell} className="skeleton h-10 w-full" />
              ))}
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
