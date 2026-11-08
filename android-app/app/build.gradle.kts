import java.util.Base64

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val apiBase: String = (project.findProperty("cleancartApiBase") as String?) ?: "https://www.heybroc.com"

android {
    namespace = "com.cleancart.overlay"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.cleancart.overlay"
        minSdk = 26
        targetSdk = 36
        versionCode = 21
        versionName = "2.2.1"
        buildConfigField("String", "API_BASE", "\"$apiBase\"")
    }

    val keystoreFileEnv = System.getenv("KEYSTORE_FILE")?.takeIf { it.isNotBlank() }
    val keystoreBase64Env = System.getenv("KEYSTORE_BASE64")?.takeIf { it.isNotBlank() }
    val keystorePasswordEnv = System.getenv("KEYSTORE_PASSWORD")?.takeIf { it.isNotBlank() }
    val keyAliasEnv = System.getenv("KEY_ALIAS")?.takeIf { it.isNotBlank() }
    val keyPasswordEnv = System.getenv("KEY_PASSWORD")?.takeIf { it.isNotBlank() }

    val resolvedKeystoreFile = when {
        keystoreFileEnv != null && file(keystoreFileEnv).exists() -> file(keystoreFileEnv)
        keystoreBase64Env != null -> {
            val out = layout.buildDirectory.file("tmp/heybroc-release.jks").get().asFile
            out.parentFile.mkdirs()
            out.writeBytes(Base64.getMimeDecoder().decode(keystoreBase64Env))
            out
        }
        else -> null
    }
    val hasValidReleaseSigning = resolvedKeystoreFile != null &&
        keystorePasswordEnv != null &&
        keyAliasEnv != null &&
        keyPasswordEnv != null

    val isReleaseTaskRequested = gradle.startParameter.taskNames.any {
        it.contains("Release", ignoreCase = true) || it.contains("bundle", ignoreCase = true)
    }
    if (isReleaseTaskRequested && !hasValidReleaseSigning) {
        throw GradleException(
            "Release build requires KEYSTORE_FILE (or KEYSTORE_BASE64), KEYSTORE_PASSWORD, KEY_ALIAS, and KEY_PASSWORD environment variables."
        )
    }

    signingConfigs {
        create("release") {
            if (hasValidReleaseSigning) {
                storeFile = resolvedKeystoreFile
                storePassword = keystorePasswordEnv
                keyAlias = keyAliasEnv
                keyPassword = keyPasswordEnv
                enableV1Signing = true
                enableV2Signing = true
            }
        }
    }

    buildFeatures { buildConfig = true }

    lint {
        abortOnError = true
        checkReleaseBuilds = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

// No third-party dependencies: plain Android framework views + HttpURLConnection + org.json.
