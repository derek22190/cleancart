# HeyBroc Android Release ProGuard / R8 Rules
# Preserve WebView @JavascriptInterface bridges, Play Billing, Credential Manager, and Android entrypoints.

-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod,Exceptions

# Keep WebView @JavascriptInterface methods and bridge classes intact
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.cleancart.overlay.LiveStoreBrowserActivity$AndroidStoreBridge {
    *;
}

# Keep Android manifest components & BuildConfig
-keep public class com.cleancart.overlay.BuildConfig { *; }
-keep public class com.cleancart.overlay.MainActivity { *; }
-keep public class com.cleancart.overlay.LiveStoreBrowserActivity { *; }
-keep public class com.cleancart.overlay.OverlayWindowService { *; }
-keep public class com.cleancart.overlay.GroceryScreenReaderService { *; }

# Keep Google Play Billing client classes (used in play flavor)
-keep class com.android.billingclient.** { *; }
-dontwarn com.android.billingclient.**

# Keep AndroidX Credential Manager & Google Sign-In Identity classes
-keep class androidx.credentials.** { *; }
-keep class com.google.android.libraries.identity.googleid.** { *; }
-dontwarn androidx.credentials.**
-dontwarn com.google.android.libraries.identity.googleid.**

# Preserve org.json and Kotlin metadata safely
-keep class org.json.** { *; }
-keep class kotlin.Metadata { *; }
