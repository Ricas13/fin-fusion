BEGIN;

CREATE TABLE support_tickets (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    ticket_number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    subject text NOT NULL,
    category text NOT NULL DEFAULT 'other',
    priority text NOT NULL DEFAULT 'normal',
    status text NOT NULL DEFAULT 'open',
    assigned_admin_user_id uuid,
    last_customer_reply_at timestamp with time zone,
    last_staff_reply_at timestamp with time zone,
    resolved_at timestamp with time zone,
    closed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT support_ticket_subject_length CHECK (char_length(subject) BETWEEN 3 AND 180),
    CONSTRAINT support_ticket_category CHECK (category IN ('billing','access','technical','content','account','other')),
    CONSTRAINT support_ticket_priority CHECK (priority IN ('low','normal','high','urgent')),
    CONSTRAINT support_ticket_status CHECK (status IN ('open','awaiting_staff','awaiting_customer','resolved','closed'))
);

CREATE TABLE support_ticket_messages (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    author_kind text NOT NULL,
    author_user_id uuid,
    body text NOT NULL,
    internal_note boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT support_ticket_message_author CHECK (author_kind IN ('customer','admin')),
    CONSTRAINT support_ticket_message_body_length CHECK (char_length(body) BETWEEN 1 AND 10000),
    CONSTRAINT support_ticket_internal_note_staff_only CHECK (internal_note=FALSE OR author_kind='admin')
);

CREATE INDEX support_tickets_customer_updated_idx ON support_tickets(customer_id,updated_at DESC);
CREATE INDEX support_tickets_staff_queue_idx ON support_tickets(status,updated_at DESC);
CREATE INDEX support_ticket_messages_ticket_created_idx ON support_ticket_messages(ticket_id,created_at,id);

COMMIT;
