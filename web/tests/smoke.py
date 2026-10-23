"""Browser smoke test with a mocked Supabase API (no real backend).
Verifies: RTL layout, auth guard routing, every route renders without console errors."""
import json, re, sys, time
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:4173'
UID = '00000000-0000-0000-0000-000000000001'
PERMS = ['users.read','users.manage','lawyers.review','lawyers.manage','lawyers.identity.read','consultations.manage','library.manage','templates.manage','categories.manage','settings.manage','audit.read','reports.read']

def profile(kind):
    return {'id': UID, 'account_type': kind, 'status': 'active', 'full_name': 'اختبار', 'email': 't@example.com', 'phone': None, 'language': 'ar', 'timezone': 'Africa/Cairo'}

def make_handler(kind):
    def handle(route, request):
        url = request.url
        path = url.split('mock.local', 1)[1].split('?')[0]
        accept = request.headers.get('accept', '')
        single = 'pgrst.object' in accept
        def ok(body, status=200):
            route.fulfill(status=status, content_type='application/json', body=json.dumps(body), headers={'access-control-allow-origin': '*'})
        if request.method == 'OPTIONS':
            return route.fulfill(status=204, headers={'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*'})
        if path.startswith('/auth/v1/user'):
            return ok({'id': UID, 'email': 't@example.com'})
        if path.startswith('/rest/v1/rpc/'):
            fn = path.rsplit('/', 1)[1]
            if fn == 'admin_dashboard_stats':
                return ok({k: 1 for k in ['total_users','total_clients','approved_lawyers','pending_applications','rejected_applications','suspended_lawyers','total_consultations','pending_consultations','assigned_consultations','answered_consultations']})
            if fn == 'admin_report_summary':
                return ok({'consultations_by_status': {'submitted': 2}, 'consultations_by_category': [], 'signups_by_month': [], 'lawyers_by_status': {}, 'open_resource_reports': 0})
            if fn == 'lawyer_dashboard_summary':
                return ok({})
            return ok([])
        if path.startswith('/rest/v1/'):
            table = path.rsplit('/', 1)[1]
            if table == 'profiles': return ok(profile(kind))
            if table == 'admin_users': return ok({'role': 'super_admin'})
            if table == 'admin_role_permissions': return ok([{'permission': p} for p in PERMS])
            if table == 'lawyer_profiles' and kind == 'lawyer':
                return ok({'user_id': UID, 'verification_status': 'approved', 'public_alias': 'Advocate #A1001'})
            if single: return route.fulfill(status=406, content_type='application/json', body=json.dumps({'code': 'PGRST116', 'message': 'no rows'}), headers={'access-control-allow-origin': '*'})
            return route.fulfill(status=200, content_type='application/json', body='[]', headers={'access-control-allow-origin': '*', 'content-range': '*/0'})
        return ok({})
    return handle

def session_json():
    return json.dumps({'access_token': 'a.b.c', 'refresh_token': 'r', 'token_type': 'bearer', 'expires_in': 3600, 'expires_at': int(time.time()) + 3600,
                       'user': {'id': UID, 'aud': 'authenticated', 'email': 't@example.com', 'app_metadata': {}, 'user_metadata': {}, 'created_at': '2026-01-01T00:00:00Z'}})

ROUTES = {
  'admin': ['/admin','/admin/lawyers','/admin/consultations','/admin/users','/admin/library','/admin/templates','/admin/settings','/admin/reports','/admin/audit','/admin/directory','/admin/about','/admin/profile','/admin/notifications'],
  'client': ['/client','/client/new','/client/ask','/client/assistant','/client/directory','/client/about','/client/notifications','/client/profile'],
  'lawyer': ['/lawyer','/lawyer/calendar','/lawyer/cases','/lawyer/clients','/lawyer/finance','/lawyer/consultations','/lawyer/library','/lawyer/templates','/lawyer/about','/lawyer/notifications','/lawyer/profile'],
}

def main():
    failures = []
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/opt/pw-browsers/chromium' if False else None)
        # unauthenticated: guard + RTL
        ctx = b.new_context(); page = ctx.new_page()
        page.route('http://mock.local/**', make_handler('client'))
        page.goto(BASE + '/client'); page.wait_for_url('**/login')
        if page.evaluate('document.documentElement.dir') != 'rtl': failures.append('default direction is not rtl')
        if not page.locator('input[type=email]').count(): failures.append('login form missing')
        page.screenshot(path='/tmp/smoke-login.png')
        ctx.close()
        for kind, routes in ROUTES.items():
            ctx = b.new_context(viewport={'width': 1280, 'height': 800}); page = ctx.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text and 'WebSocket' not in m.text else None)
            page.route('http://mock.local/**', make_handler(kind))
            page.add_init_script(f"localStorage.setItem('sb-mock-auth-token', {json.dumps(session_json())})")
            for r in routes:
                errors.clear()
                page.goto(BASE + r); page.wait_for_load_state('networkidle'); page.wait_for_timeout(300)
                url_ok = page.url.rstrip('/').endswith(r.rstrip('/'))
                body = page.inner_text('body')
                if not url_ok: failures.append(f'{kind} {r}: redirected to {page.url}')
                if re.search(r'\b(nav|common|admin|cons|lib|fin|cal|cases|dash|tpl|settings|lawyer|clients)\.[a-z_]+\b', body): failures.append(f'{kind} {r}: untranslated key visible: {re.search(r"\b(nav|common|admin|cons|lib|fin|cal|cases|dash|tpl|settings|lawyer|clients)\.[a-z_]+\b", body).group(0)}')
                if errors: failures.append(f'{kind} {r}: console errors: {errors[:2]}')
            if kind == 'admin':
                page.goto(BASE + '/admin'); page.wait_for_load_state('networkidle')
                page.screenshot(path='/tmp/smoke-admin.png')
                # cross-role guard
                page.goto(BASE + '/lawyer'); page.wait_for_load_state('networkidle'); page.wait_for_timeout(300)
                if '/admin' not in page.url: failures.append('admin allowed into /lawyer')
            if kind == 'client':
                page.goto(BASE + '/admin'); page.wait_for_load_state('networkidle'); page.wait_for_timeout(300)
                if '/client' not in page.url: failures.append('client allowed into /admin')
                page.goto(BASE + '/client/new'); page.wait_for_load_state('networkidle')
                page.screenshot(path='/tmp/smoke-client-new.png')
            ctx.close()
        b.close()
    print('FAILURES:' if failures else 'SMOKE OK')
    for f in failures: print(' -', f)
    sys.exit(1 if failures else 0)
main()
