"use client";

import { Check, ShoppingBag } from "lucide-react";
import { useState } from "react";
import { cart, formatPrice, totalPaise } from "../lib/cart";

export function CheckoutPreview({ enabled }: { enabled: boolean }) {
  const [reviewing, setReviewing] = useState(false);

  return (
    <section className="checkout panel" aria-labelledby="checkout-heading" data-enabled={enabled}>
      <header className="panel-heading">
        <h2 id="checkout-heading">{enabled ? "Express checkout" : "Classic checkout"}</h2>
        <ShoppingBag size={20} strokeWidth={1.5} aria-hidden="true" />
      </header>
      <p className="checkout-intro">
        {enabled
          ? "Your order, delivery, and total. Together in one step."
          : "Review your bag, then continue to your order summary."}
      </p>
      <ul className="cart" aria-label="Shopping bag">
        {cart.map((item) => (
          <li className="cart-row" key={item.name}>
            <div>
              <p>{item.name}</p>
              <p className="muted small">
                {item.detail} / Qty {item.quantity}
              </p>
            </div>
            <span className="amount">{formatPrice(item.price * item.quantity)}</span>
          </li>
        ))}
      </ul>

      {enabled && (
        <div className="delivery-summary">
          <Check size={18} strokeWidth={1.5} aria-hidden="true" />
          <div>
            <p>Delivery included</p>
            <p className="muted small">Your pro plan includes standard shipping in India.</p>
          </div>
        </div>
      )}

      <dl className="order-total">
        <dt>Total</dt>
        <dd className="amount">{formatPrice(totalPaise)}</dd>
      </dl>
      <button className="button primary checkout-action" onClick={() => setReviewing(!reviewing)}>
        {reviewing ? "Back to bag" : enabled ? "Review express order" : "Continue to review"}
      </button>
      {reviewing && (
        <div className="review" role="status">
          <p>Order ready to review</p>
          <p className="muted small">
            {cart.reduce((sum, item) => sum + item.quantity, 0)} items, {formatPrice(totalPaise)}.
            This is a local preview; no order has been placed.
          </p>
        </div>
      )}
      <p className="muted small preview-note">
        Sample cart. The flag selects the checkout experience.
      </p>
    </section>
  );
}
