# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Generated manually for the AI chat feature

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("db", "0122_ai_chat"),
    ]

    operations = [
        migrations.AddField(
            model_name="aichatmessage",
            name="meta",
            field=models.JSONField(blank=True, default=dict),
        ),
    ]
