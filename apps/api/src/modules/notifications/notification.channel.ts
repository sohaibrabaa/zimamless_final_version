import { Injectable, Logger } from '@nestjs/common';

/**
 * Delivery channels, behind a symbol (ZM-NOT-*, ZM-GOV-009's pattern).
 *
 * Same discipline as `SIGNATURE_PROVIDER` and `SETTLEMENT_PROVIDER`: nothing in
 * the domain names a concrete adapter, so swapping a dummy for a real email or
 * WhatsApp gateway is a one-line change in `app.module.ts` and nothing else.
 *
 * The dummies are honest about being dummies. They record a provider reference
 * and a delivery result exactly as a real gateway would, so the evidence trail
 * has the same shape in a demo as in production — and they never pretend a
 * message reached a human. `EMAIL` and `WHATSAPP` mark themselves `SENT`, not
 * `DELIVERED`: handing a message to a gateway is not the same as it arriving,
 * and a system that recorded delivery it could not observe would be
 * manufacturing evidence.
 */

export const NOTIFICATION_CHANNELS = Symbol('NOTIFICATION_CHANNELS');

export type NotificationChannel = 'EMAIL' | 'WHATSAPP' | 'IN_PLATFORM' | 'MANUAL_CALL';
export type NotificationStatus =
  | 'QUEUED'
  | 'SENT'
  | 'DELIVERED'
  | 'FAILED'
  | 'BOUNCED'
  | 'SUPPRESSED';

export interface DeliveryRequest {
  notificationId: string;
  destination: string;
  subject: string | null;
  body: string;
  language: 'EN' | 'AR';
}

export interface DeliveryResult {
  status: NotificationStatus;
  providerReference: string | null;
  failureReason: string | null;
}

export interface NotificationChannelAdapter {
  readonly channel: NotificationChannel;
  send(request: DeliveryRequest): Promise<DeliveryResult>;
}

/**
 * In-platform delivery: the notification row IS the message.
 *
 * There is nothing to transmit, so it is immediately `SENT` — but deliberately
 * not `DELIVERED`. For an in-platform message, delivery is the user actually
 * opening it, which is what `POST /notifications/{id}/read` records. Marking
 * it delivered at creation would make the read flag meaningless.
 */
@Injectable()
export class InPlatformChannel implements NotificationChannelAdapter {
  readonly channel = 'IN_PLATFORM' as const;

  async send(request: DeliveryRequest): Promise<DeliveryResult> {
    return {
      status: 'SENT',
      providerReference: `in-platform:${request.notificationId}`,
      failureReason: null,
    };
  }
}

@Injectable()
export class DummyEmailChannel implements NotificationChannelAdapter {
  readonly channel = 'EMAIL' as const;
  private readonly logger = new Logger(DummyEmailChannel.name);

  async send(request: DeliveryRequest): Promise<DeliveryResult> {
    if (!request.destination.includes('@')) {
      // A real gateway would bounce this, so the dummy does too — otherwise
      // the failure path is only ever exercised in production.
      return {
        status: 'BOUNCED',
        providerReference: null,
        failureReason: 'INVALID_ADDRESS',
      };
    }
    this.logger.debug(`[dummy email] → ${request.destination}: ${request.subject}`);
    return {
      status: 'SENT',
      providerReference: `dummy-email:${request.notificationId}`,
      failureReason: null,
    };
  }
}

@Injectable()
export class DummyWhatsappChannel implements NotificationChannelAdapter {
  readonly channel = 'WHATSAPP' as const;
  private readonly logger = new Logger(DummyWhatsappChannel.name);

  async send(request: DeliveryRequest): Promise<DeliveryResult> {
    // Jordanian mobile numbers in E.164. A gateway would reject anything else.
    if (!/^\+9627\d{8}$/.test(request.destination)) {
      return {
        status: 'BOUNCED',
        providerReference: null,
        failureReason: 'INVALID_MSISDN',
      };
    }
    this.logger.debug(`[dummy whatsapp] → ${request.destination}`);
    return {
      status: 'SENT',
      providerReference: `dummy-whatsapp:${request.notificationId}`,
      failureReason: null,
    };
  }
}

/**
 * A phone call a human made (ZM-NOT-007).
 *
 * Not automated and not pretending to be: this adapter never sends anything.
 * It exists so that a call an operator actually made is recorded through the
 * same pipeline as everything else, with the same evidence fields, rather than
 * living in someone's notebook. The status stays `QUEUED` until a human
 * records the call and its notes.
 */
@Injectable()
export class ManualCallChannel implements NotificationChannelAdapter {
  readonly channel = 'MANUAL_CALL' as const;

  async send(): Promise<DeliveryResult> {
    return {
      status: 'QUEUED',
      providerReference: null,
      failureReason: null,
    };
  }
}
