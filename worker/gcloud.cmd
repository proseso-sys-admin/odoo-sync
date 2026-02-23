@echo off
set "GCLOUD_BIN=C:\Users\Admin\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin"
set "PATH=%GCLOUD_BIN%;%PATH%"
"%GCLOUD_BIN%\gcloud.cmd" %*
