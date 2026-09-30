package org.leonz.whisper;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileNotFoundException;

/** Grants the system installer read access to exactly one verified public APK. */
public final class UpdateProvider extends ContentProvider {
    public static final String AUTHORITY = "org.leonz.whisper.updates";
    public static final Uri URI = Uri.parse("content://" + AUTHORITY + "/package.apk");
    @Override public boolean onCreate() { return true; }
    private File file(Uri uri) throws FileNotFoundException {
        if (!URI.equals(uri)) throw new FileNotFoundException("Unknown update");
        File file = new File(getContext().getCacheDir(), "updates/package.apk");
        if (!file.isFile()) throw new FileNotFoundException("Update unavailable");
        return file;
    }
    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) throw new FileNotFoundException("Read only");
        return ParcelFileDescriptor.open(file(uri), ParcelFileDescriptor.MODE_READ_ONLY);
    }
    @Override public String getType(Uri uri) { return URI.equals(uri) ? "application/vnd.android.package-archive" : null; }
    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sortOrder) {
        if (selection != null || args != null || sortOrder != null) return null;
        try {
            File file = file(uri);
            String[] names = projection == null ? new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE} : projection;
            MatrixCursor cursor = new MatrixCursor(names); Object[] values = new Object[names.length];
            for (int i = 0; i < names.length; i++) values[i] = OpenableColumns.DISPLAY_NAME.equals(names[i]) ? "Whisper.apk" : OpenableColumns.SIZE.equals(names[i]) ? file.length() : null;
            cursor.addRow(values); return cursor;
        } catch (FileNotFoundException ignored) { return null; }
    }
    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException(); }
}
