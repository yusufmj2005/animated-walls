using System.Security.Cryptography;
using System.Text;

namespace AnimatedWalls.Engine.IPC;

/// <summary>
/// Mutual proof of a shared secret, without the secret ever crossing the pipe. The
/// token reaches the engine over stdin from the process that spawned it, which keeps it
/// out of the command line that any process can read.
///
/// Both directions matter. Proving the client stops another local process driving the
/// engine. Proving the server stops a process that grabbed the pipe name from
/// impersonating the engine to Electron.
/// </summary>
public sealed class SessionAuthenticator(byte[] token)
{
    public static string CreateNonce() => Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));

    public string ServerProof(string clientNonce) => Proof("server:", clientNonce);

    public bool VerifyClientProof(string serverNonce, string clientProof)
    {
        var expected = Encoding.UTF8.GetBytes(Proof("client:", serverNonce));
        var actual = Encoding.UTF8.GetBytes(clientProof);
        return CryptographicOperations.FixedTimeEquals(expected, actual);
    }

    private string Proof(string role, string nonce) =>
        Convert.ToBase64String(HMACSHA256.HashData(token, Encoding.UTF8.GetBytes(role + nonce)));
}
