package com.cleancart.overlay

import android.content.Context

/**
 * Tracks explicit user consent and revocation for the Prominent Accessibility Service Disclosure.
 * Screen reading is active only after the user explicitly accepts the in-app disclosure.
 */
object AccessibilityConsent {
    private const val VERSION = 2
    private const val PREFS = "heybroc_consent"
    private const val KEY = "accessibility_disclosure_version"
    private const val KEY_REVOKED = "accessibility_revoked"

    fun granted(ctx: Context): Boolean {
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return !prefs.getBoolean(KEY_REVOKED, false) && prefs.getInt(KEY, 0) >= 1
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
