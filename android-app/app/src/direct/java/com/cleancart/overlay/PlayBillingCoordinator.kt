package com.cleancart.overlay

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.widget.Toast

/**
 * Direct sideload APK distribution coordinator (`direct` product flavor).
 * Keeps web upgrade and Stripe billing portal links for non-Play APK installs.
 */
object PlayBillingCoordinator {
    const val EXTRA_OPEN_PLAY_PAYWALL = "com.cleancart.overlay.OPEN_PLAY_PAYWALL"
    private val mainHandler = Handler(Looper.getMainLooper())

    fun openUpgradeFromContext(context: Context) {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(ScanApi.upgradeUrl(context))).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        runCatching { context.startActivity(intent) }
    }

    fun openUpgradeFlow(activity: Activity, @Suppress("UNUSED_PARAMETER") onProActivated: (() -> Unit)? = null) {
        ScanApi.trackEvent(activity, "checkout_started")
        runCatching {
            activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(ScanApi.upgradeUrl(activity))))
        }
    }

    fun openManageSubscription(activity: Activity) {
        Toast.makeText(activity, "Opening subscription management…", Toast.LENGTH_SHORT).show()
        val appCtx = activity.applicationContext
        Thread {
            val portalUrl = ScanApi.billingPortalUrl(appCtx)
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
