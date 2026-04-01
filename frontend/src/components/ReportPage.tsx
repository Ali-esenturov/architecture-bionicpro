import React, { useEffect, useMemo, useState } from 'react';

const ReportPage: React.FC = () => {
  const authServiceBaseUrl = useMemo(
    () => process.env.REACT_APP_AUTH_SERVICE_URL || 'http://localhost:8081',
    []
  );
  const [initialized, setInitialized] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [accessTokenExpiresAt, setAccessTokenExpiresAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadSession = async () => {
      try {
        const response = await fetch(`${authServiceBaseUrl}/auth/session`, {
          credentials: 'include'
        });
        if (response.ok) {
          const data = await response.json();
          setSessionId(data?.sessionId ?? 'active');
          if (data?.accessTokenExpiresAt) {
            setAccessTokenExpiresAt(Number(data.accessTokenExpiresAt));
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred');
      } finally {
        setInitialized(true);
      }
    };

    loadSession();
  }, [authServiceBaseUrl]);

  const startLogin = async () => {
    setError(null);
    try {
      const response = await fetch(`${authServiceBaseUrl}/auth/pkce/start`, {
        credentials: 'include'
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || 'Failed to start login');
      }
      if (!data?.authUrl) {
        throw new Error('Auth URL missing in response');
      }
      window.location.href = data.authUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    }
  };

  const downloadReport = async () => {
    try {
      setLoading(true);
      setError(null);

      const response = await fetch(`${authServiceBaseUrl}/reports`, {
        credentials: 'include'
      });

      
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  if (!initialized) {
    return <div>Loading...</div>;
  }

  if (!sessionId) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-gray-100">
        <button
          onClick={startLogin}
          className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
        >
          Login
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-100">
      <div className="p-8 bg-white rounded-lg shadow-md">
        <h1 className="text-2xl font-bold mb-6">Usage Reports</h1>

        {accessTokenExpiresAt && (
          <div className="mb-4 text-sm text-gray-600">
            Session expires at: {new Date(accessTokenExpiresAt).toLocaleString()}
          </div>
        )}
        
        <button
          onClick={downloadReport}
          disabled={loading}
          className={`px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 ${
            loading ? 'opacity-50 cursor-not-allowed' : ''
          }`}
        >
          {loading ? 'Generating Report...' : 'Download Report'}
        </button>

        {error && (
          <div className="mt-4 p-4 bg-red-100 text-red-700 rounded">
            {error}
          </div>
        )}
      </div>
    </div>
  );
};

export default ReportPage;
