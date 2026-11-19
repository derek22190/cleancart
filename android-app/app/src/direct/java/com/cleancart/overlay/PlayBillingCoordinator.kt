package com.cleancart.overlay

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.widget.Toast
import org.json.JSONObject

/**
 * Direct sideload APK distribution coordinator (`direct` product flavor).
 * Keeps web upgrade and Stripe billing portal links exclusively in the `direct` source set
 * (migrated from legacy `ScanApi.upgradeUrl` and `ScanApi.billingPortalUrl` so the `play`
 * flavor compiles with zero external web-checkout or Stripe portal URLs).
 */
object PlayBillingCoordinator {
    const val EXTRA_OPEN_PLAY_PAYWALL = "com.cleancart.overlay.OPEN_PLAY_PAYWALL"
    private const val PREFS_NAME = "ingredient_preferences"
    private val customBase = BuildConfig.API_BASE.trim().trimEnd('/')
    private val BILLING_PORTAL_ENDPOINTS = listOfNotNull(
        customBase.takeIf { it.isNotBlank() }?.let { "$it/api/billing/portal" },
        "https://www.heybroc.com/api/billing/portal",
        "https://heybroc.com/api/billing/portal",
    ).distinct()
    private val mainHandler = Handler(Looper.getMainLooper())

    fun upgradeUrl(ctx: Context): String {
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val id = Uri.encode(ScanApi.deviceId(ctx))
        val ref = ScanApi.referredByCode(ctx)?.takeIf { it.isNotBlank() }?.let { "&code=${Uri.encode(it)}" }.orEmpty()
        val email = prefs.getString("auth_email", null)?.trim()?.takeIf { it.isNotBlank() }
            ?.let { "&email=${Uri.encode(it)}" }.orEmpty()
        return "https://www.heybroc.com/?upgrade=1&deviceId=$id$ref$email"
    }

    /** Blocking call — fetches a Stripe Billing Portal session URL for one-tap subscription cancellation/management. */
    fun billingPortalUrl(ctx: Context): String? {
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val email = prefs.getString("auth_email", null)?.trim()
        val authToken = prefs.getString("auth_token", null)?.trim()
        val secret = ScanApi.deviceSecret(ctx)
        val body = JSONObject().apply {
            put("deviceId", ScanApi.deviceId(ctx))
            put("deviceSecret", secret)
            if (!email.isNullOrBlank()) put("email", email)
        }.toString()
        val headers = mutableMapOf("X-Device-Secret" to secret)
        if (!authToken.isNullOrBlank()) {
            headers["Authorization"] = "Bearer $authToken"
        }
        for (endpoint in BILLING_PORTAL_ENDPOINTS) {
            try {
                val res = ScanApi.postFollowingRedirects(
                    endpoint,
                    body,
                    maxRedirects = 4,
                    extraHeaders = headers
                )
                if (res.startsWith("{")) {
                    val json = JSONObject(res)
                    val url = json.optString("url").trim()
                    if (url.startsWith("https://")) return url
                }
            } catch (_: Exception) {
                // try next endpoint
            }
        }
        return null
    }

    fun cachedLocalizedPricingSummary(): String? = null

    fun syncExistingPurchases(
        @Suppress("UNUSED_PARAMETER") ctx: Context,
        @Suppress("UNUSED_PARAMETER") onProActivated: (() -> Unit)? = null
    ) {
        // No-op on direct sideload flavor (entitlements sync via ScanApi.syncEntitlementAsync).
    }

    fun openUpgradeFromContext(context: Context) {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(upgradeUrl(context))).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        runCatching { context.startActivity(intent) }
    }

    fun openUpgradeFlow(activity: Activity, @Suppress("UNUSED_PARAMETER") onProActivated: (() -> Unit)? = null) {
        ScanApi.trackEvent(activity, "checkout_started")
        runCatching {
            activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(upgradeUrl(activity))))
        }
    }

    fun openManageSubscription(activity: Activity) {
        Toast.makeText(activity, "Opening subscription management…", Toast.LENGTH_SHORT).show()
        val appCtx = activity.applicationContext
        Thread {
            val portalUrl = billingPortalUrl(appCtx)
            mainHandler.post {
                if (activity.isDestroyed || activity.isFinishing) return@post
                val targetUrl = portalUrl ?: "https://www.heybroc.com/?login=1"
                runCatching {
                    activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(targetUrl)))
                }
            }
        }.start()
    }
}
