"""
noise_create.py
---------------
사인파(sine wave)와 노이즈 신호를 생성·시각화하는 모듈.

노이즈 캔슬링 시스템 구현의 초기 탐색 단계로,
신호 생성 방법을 numpy/matplotlib으로 실험한다.

파이프라인에서의 위치:
    [신호 생성] → 노이즈 오염 → 적응 필터(NLMS) → 클린 신호
"""

import numpy as np
import matplotlib.pyplot as plt
import math
import random


def sin(x):
    """
    0 ~ x*π 범위의 사인파를 생성하고 그래프로 출력한다.

    매개변수:
        x (float): 표시할 사인파의 반주기 수.
                   예) x=2 이면 0 ~ 2π 범위, 즉 사인파 1주기를 표시.

    동작:
        1. np.linspace 로 x축(시간축) 1000개 샘플 생성
        2. np.sin 으로 각 샘플의 사인값 계산
        3. matplotlib 으로 시각화
    """
    x = np.linspace(0, x * math.pi, 1000)  # 0 ~ x*π 구간을 1000등분
    y = np.sin(x)                           # 각 점에서의 sin 값

    plt.plot(x, y)
    plt.show()


def noise():
    """
    랜덤 노이즈 신호를 생성하고 그래프로 출력한다.

    NOTE: 현재 미완성 상태. 다음 두 가지 버그가 있다.
      - Bug 1: `x`가 매개변수 없이 linspace 안에서 참조됨 → NameError 발생
               수정안: `def noise(duration_pi=2):` 처럼 매개변수를 추가해야 함
      - Bug 2: `random()` 은 단일 float 하나만 반환하므로 길이 1000인 x와
               크기가 맞지 않아 plt.plot 이 실패함
               수정안: `np.random.rand(1000)` 으로 교체해야 함
    """
    # TODO: 매개변수(길이, 진폭 등)를 받도록 함수 시그니처 수정 필요
    x = np.linspace(0, x * math.pi, 1000)  # BUG: x 미정의 상태에서 참조됨
    y = random()                            # BUG: 단일 float → 배열 크기 불일치

    plt.plot(x, y)
    plt.show()
