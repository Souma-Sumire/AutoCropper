from app import app

def test_ping_route():
    client = app.test_client()
    response = client.get('/api/ping')
    assert response.status_code == 200
    data = response.get_json()
    assert data['status'] == 'ok'
