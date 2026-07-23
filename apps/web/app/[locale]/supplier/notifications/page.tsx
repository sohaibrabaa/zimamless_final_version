import { NotificationInbox } from "@/components/payments/NotificationInbox";

/**
 * One inbox component across all three portals: a notification is addressed to
 * a person, not an organization, so the same user has one inbox whichever
 * context they are in.
 */
export default function Page() {
  return <NotificationInbox />;
}
