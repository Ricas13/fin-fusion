BEGIN;

CREATE OR REPLACE VIEW media_jobs AS
SELECT id,customer_id,reseller_id,media_type,title,external_id,request_text,status,admin_response,created_at,resolved_at,
       tmdb_id,tvdb_id,year,poster_path,backdrop_path,quality_tier_id,arr_instance_id,arr_item_id,routed_at,
       last_status_check,available_at,last_error
FROM content_requests;

CREATE OR REPLACE VIEW media_quality_options AS
SELECT qt.id,qt.code,qt.name,qt.description,qt.active,qt.sort_order,
       rr.media_type,rr.search_on_add,rr.enabled AS route_enabled,
       rr.arr_instance_id,ai.name AS instance_name,ai.kind AS instance_kind,ai.enabled AS instance_enabled
FROM request_quality_tiers qt
LEFT JOIN request_routes rr ON rr.quality_tier_id=qt.id
LEFT JOIN arr_instances ai ON ai.id=rr.arr_instance_id;

CREATE OR REPLACE VIEW media_route_details AS
SELECT rr.id,rr.quality_tier_id,qt.code AS tier_code,qt.name AS tier_name,rr.media_type,
       rr.arr_instance_id,ai.name AS instance_name,ai.kind AS instance_kind,ai.health_status,
       rr.quality_profile_id,rr.quality_profile_name,rr.root_folder_path,rr.monitor_mode,
       rr.search_on_add,rr.enabled,rr.created_at,rr.updated_at
FROM request_routes rr
JOIN request_quality_tiers qt ON qt.id=rr.quality_tier_id
JOIN arr_instances ai ON ai.id=rr.arr_instance_id;

CREATE OR REPLACE VIEW media_admin_queue AS
SELECT cr.id,cr.customer_id,cr.reseller_id,cr.media_type,cr.title,cr.status,cr.created_at,cr.resolved_at,
       cr.tmdb_id,cr.tvdb_id,cr.year,cr.poster_path,cr.quality_tier_id,cr.arr_instance_id,cr.arr_item_id,
       cr.routed_at,cr.last_status_check,cr.available_at,cr.last_error,cr.admin_response,
       qt.name AS quality_name,qt.code AS quality_code,
       c.display_name AS customer_name,c.email AS customer_email,
       ru.username AS reseller_username,ai.name AS instance_name
FROM content_requests cr
LEFT JOIN request_quality_tiers qt ON qt.id=cr.quality_tier_id
LEFT JOIN customers c ON c.id=cr.customer_id
LEFT JOIN resellers rs ON rs.id=cr.reseller_id
LEFT JOIN app_users ru ON ru.id=rs.user_id
LEFT JOIN arr_instances ai ON ai.id=cr.arr_instance_id;

COMMIT;
