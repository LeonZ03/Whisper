package org.leonz.whisper;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

/** Device-bound encrypted login only. No passwords, messages or plaintext files. */
final class SessionVault {
    private static final String ALIAS = "whisper.login.v1";
    private static final byte[] AAD = ("org.leonz.whisper|" + CloudTransport.SERVER + "|login-v1").getBytes(StandardCharsets.UTF_8);
    private static final int LIMIT = 8192;
    private final AtomicFile file;
    SessionVault(Context context) { file = new AtomicFile(new File(context.getNoBackupFilesDir(), "login.sealed")); }

    private SecretKey key(boolean create) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(ALIAS)) return (SecretKey) store.getKey(ALIAS, null);
        if (!create) throw new java.security.GeneralSecurityException("Device key unavailable");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256).setRandomizedEncryptionRequired(true).build());
        return generator.generateKey();
    }
    synchronized void save(String cookie, String identity) throws Exception {
        if (cookie == null || !cookie.matches("whisper_session=[A-Za-z0-9_-]{43}") || identity == null || identity.length() > 4096)
            throw new IllegalArgumentException("Invalid login");
        JSONObject user = new JSONObject(identity);
        if (user.optInt("v") != 1 || !user.optString("id").matches("[0-9a-f-]{36}")
            || !user.optString("username").matches("[a-z0-9_]{3,24}")
            || !user.optString("publicKey").matches("[A-Za-z0-9+/]{43}=")
            || !user.optString("secretKey").matches("[A-Za-z0-9+/]{43}=")) throw new IllegalArgumentException("Invalid identity");
        // Whitelist the payload; never accept arbitrary message bodies or passwords.
        JSONObject safe = new JSONObject(); safe.put("v", 1); safe.put("id", user.getString("id"));
        safe.put("username", user.getString("username")); safe.put("publicKey", user.getString("publicKey"));
        safe.put("secretKey", user.getString("secretKey"));
        JSONObject login = new JSONObject(); login.put("cookie", cookie); login.put("identity", safe);
        byte[] plain = login.toString().getBytes(StandardCharsets.UTF_8);
        FileOutputStream output = null;
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key(true)); cipher.updateAAD(AAD);
            byte[] encrypted = cipher.doFinal(plain), iv = cipher.getIV();
            if (iv.length != 12) throw new java.security.GeneralSecurityException("Unexpected IV");
            output = file.startWrite(); output.write(1); output.write(iv); output.write(encrypted); file.finishWrite(output); output = null;
        } finally { Arrays.fill(plain, (byte) 0); if (output != null) file.failWrite(output); }
    }
    synchronized JSONObject load() throws Exception {
        if (!file.getBaseFile().exists()) return null;
        if (file.getBaseFile().length() > LIMIT) throw new java.io.IOException("Login file limit");
        byte[] encrypted = file.readFully(), plain = null;
        try {
            if (encrypted.length < 30 || encrypted[0] != 1) throw new java.io.IOException("Invalid login file");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, Arrays.copyOfRange(encrypted, 1, 13))); cipher.updateAAD(AAD);
            plain = cipher.doFinal(encrypted, 13, encrypted.length - 13);
            JSONObject login = new JSONObject(new String(plain, StandardCharsets.UTF_8));
            if (!login.getString("cookie").matches("whisper_session=[A-Za-z0-9_-]{43}")) throw new java.io.IOException("Invalid session");
            return login;
        } finally { Arrays.fill(encrypted, (byte) 0); if (plain != null) Arrays.fill(plain, (byte) 0); }
    }
    synchronized void clear() {
        file.delete();
        try { KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null); store.deleteEntry(ALIAS); }
        catch (Exception ignored) { /* The sealed file is already removed. Never log login material. */ }
    }
}
