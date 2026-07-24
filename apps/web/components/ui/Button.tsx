import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";
import { clsx } from "@/lib/clsx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-(--color-primary) text-(--color-primary-fg) hover:bg-(--color-primary-hover) disabled:opacity-50",
  secondary:
    "bg-(--color-surface) text-(--color-secondary) border border-(--color-border) hover:bg-(--color-neutral-bg) disabled:opacity-50",
  ghost: "bg-transparent text-(--color-fg) hover:bg-(--color-neutral-bg) disabled:opacity-50",
  danger: "bg-(--color-danger) text-white hover:opacity-90 disabled:opacity-50",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "text-sm px-3 py-1.5 rounded-md gap-1.5",
  md: "text-sm px-4 py-2 rounded-md gap-2",
  lg: "text-base px-5 py-2.5 rounded-lg gap-2",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "primary", size = "md", loading, className, disabled, children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        className={clsx(
          "inline-flex items-center justify-center font-medium transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-primary) focus-visible:ring-offset-2",
          variantClasses[variant],
          sizeClasses[size],
          className
        )}
        {...props}
      >
        {loading && (
          <span
            aria-hidden
            className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-e-transparent"
          />
        )}
        {children}
      </button>
    );
  }
);
Button.displayName = "Button";
