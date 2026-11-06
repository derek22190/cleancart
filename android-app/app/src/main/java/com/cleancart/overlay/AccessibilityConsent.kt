package com.cleancart.overlay

import android.content.Context
import android.provider.Settings

/**
 * Tracks user consent and revocation for the Prominent Accessibility Service Disclosure.
 * If the user has already enabled the Accessibility Service in Android system settings and
 * has not explicitly revoked reading in-app, automatic store detection remains active.
 */
object AccessibilityConsent {
    private const val VERSION = 1
    private const val PREFS = "heybroc_consent"
    private const val KEY = "accessibility_disclosure_version"
    private const val KEY_REVOKED = "accessibility_revoked"

    fun granted(ctx: Context): Boolean {
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (prefs.getBoolean(KEY_REVOKED, false)) return false
        if (prefs.getInt(KEY, 0) == VERSION) return true
        val enabled = Settings.Secure.getString(
            ctx.contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ).orEmpty()
        return enabled.contains(ctx.packageName)
    }

    fun grant(ctx: Context) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putInt(KEY, VERSION)
            .putBoolean(KEY_REVOKED, false)
            .apply()
    }

    fun revoke(ctx: Context) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .remove(KEY)
            .putBoolean(KEY_REVOKED, true)
            .apply()
    }
}
