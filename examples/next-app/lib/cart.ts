export const cart = [
  { name: "Everyday canvas tote", detail: "Natural / one size", quantity: 1, price: 120_000 },
  { name: "Dot-grid notebook", detail: "Graphite / A5", quantity: 1, price: 35_000 },
] as const;

export const totalPaise = cart.reduce((sum, item) => sum + item.quantity * item.price, 0);

export function formatPrice(paise: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    currencyDisplay: "code",
  }).format(paise / 100);
}
