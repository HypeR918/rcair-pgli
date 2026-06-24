erDiagram
    bot_users {
        INT id PK
        BIGINT max_id UK
        VARCHAR email
        INT glpi_user_id
        VARCHAR glpi_user_name
        VARCHAR glpi_realname
        VARCHAR glpi_firstname
        INT glpi_entity_id
        VARCHAR glpi_entity_name
        TINYINT is_authorized
        TINYINT is_blocked
        DATETIME last_login_at
        DATETIME last_glpi_sync_at
        DATETIME created_at
        DATETIME updated_at
    }

    blocked_max_ids {
        BIGINT max_id PK
        DATETIME blocked_at
    }

    bot_user_tickets {
        INT id PK
        BIGINT max_id
        INT glpi_user_id
        INT glpi_ticket_id UK
        VARCHAR title
        INT status
        TINYINT solution_notified
        TINYINT closed_notified
        DATETIME created_at
        DATETIME updated_at
    }

    bot_ticket_followups {
        INT id PK
        INT glpi_ticket_id
        INT glpi_followup_id
        CHAR content_hash
        TINYINT sent_to_max
        DATETIME created_at
    }

    bot_ticket_ratings {
        INT id PK
        BIGINT max_id
        INT glpi_ticket_id UK
        TINYINT rating
        TEXT comment
        DATETIME created_at
    }

    bot_sessions {
        BIGINT max_id PK
        JSON session_data
        DATETIME updated_at
    }

    sds_requests {
        INT id PK
        BIGINT max_id
        VARCHAR email
        VARCHAR org
        VARCHAR dept
        VARCHAR fio
        VARCHAR position
        VARCHAR phone
        TEXT issue
        INT glpi_ticket_id
        INT glpi_ticket_status
        VARCHAR status
        TEXT decision_text
        DATETIME created_at
        DATETIME decided_at
    }

    bot_users ||--o{ bot_user_tickets : "создаёт"
    bot_users ||--o{ bot_ticket_ratings : "оценивает"
    bot_users ||--o| blocked_max_ids : "может быть заблокирован"
    bot_users ||--o| bot_sessions : "имеет сессию"
    bot_users ||--o{ sds_requests : "создаёт SDS"
    bot_user_tickets ||--o{ bot_ticket_followups : "имеет комментарии"
