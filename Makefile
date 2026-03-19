VERSION ?= dev
REGISTRY ?= ghcr.io/clickandmortar

IMAGES = \
	ksnapshot:Dockerfile \
	ksnapshot-dumper-mysql-8:dumpers/mysql/8/Dockerfile \
	ksnapshot-dumper-elasticsearch:dumpers/elasticsearch/Dockerfile \
	ksnapshot-dumper-postgresql-16:dumpers/postgresql/16/Dockerfile

.PHONY: all build push

all: build push

build:
	@$(foreach pair,$(IMAGES),\
		$(eval NAME = $(word 1,$(subst :, ,$(pair))))\
		$(eval FILE = $(word 2,$(subst :, ,$(pair))))\
		echo "Building $(REGISTRY)/$(NAME):$(VERSION)";\
		docker build -t $(REGISTRY)/$(NAME):$(VERSION) -f $(FILE) . &&\
	) true

push:
	@$(foreach pair,$(IMAGES),\
		$(eval NAME = $(word 1,$(subst :, ,$(pair))))\
		docker push $(REGISTRY)/$(NAME):$(VERSION) &&\
	) true
